/**
 * Thin HTTP client for the TMetric REST API v3.
 *
 * Centralises authentication, query-string building, timeouts and the mapping of
 * HTTP failures onto actionable messages, so that tool handlers only deal with
 * parsed payloads.
 */

import { API_V3_PREFIX, DEFAULT_BASE_URL, ENV, REQUEST_TIMEOUT_MS } from "../constants.js";

export type QueryValue = string | number | boolean | Array<string | number> | undefined | null;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
}

/**
 * An API failure carrying the HTTP status plus a message written for an agent:
 * it says what went wrong and what to try next.
 */
export class TMetricApiError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly endpoint: string,
    readonly details?: string,
  ) {
    super(message);
    this.name = "TMetricApiError";
  }
}

/** Builds a query string, expanding arrays into repeated keys as the API expects. */
function buildQuery(query: Record<string, QueryValue> | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

/** Extracts the most useful message out of a TMetric error payload. */
function describeErrorBody(raw: string): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of ["message", "Message", "error", "error_description", "title"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
      return JSON.stringify(parsed).slice(0, 400);
    }
  } catch {
    /* fall through to the raw text */
  }
  return raw.slice(0, 400);
}

/** Maps an HTTP status onto guidance the agent can act on. */
function messageForStatus(status: number, endpoint: string, details?: string): string {
  const suffix = details ? ` API said: ${details}` : "";
  switch (status) {
    case 400:
      return `TMetric rejected the request to ${endpoint} as invalid (400). Check that IDs exist in this workspace and that timestamps use the local format YYYY-MM-DDTHH:mm:ss without a timezone offset.${suffix}`;
    case 401:
      return `TMetric authentication failed (401). The ${ENV.TOKEN} token is missing, expired or revoked — generate a new one on the My Profile page in TMetric (tokens are valid for one year).${suffix}`;
    case 403:
      return `TMetric denied access to ${endpoint} (403). Your workspace role may not allow this action, or manual time editing may be disabled for you — check permissions with tmetric_get_current_user.${suffix}`;
    case 404:
      return `TMetric could not find ${endpoint} (404). Verify the account_id, and that the project, task or time entry id still exists.${suffix}`;
    case 409:
      return `TMetric reported a conflict for ${endpoint} (409), typically an overlap with an existing time entry. List the entries for that day with tmetric_list_time_entries before retrying.${suffix}`;
    case 429:
      return `TMetric rate limit exceeded (429). Wait a few seconds and retry; when logging many entries, use tmetric_create_time_entries_bulk instead of separate calls.${suffix}`;
    default:
      if (status >= 500) {
        return `TMetric had a server error on ${endpoint} (${status}). This is usually transient — retry in a moment.${suffix}`;
      }
      return `TMetric request to ${endpoint} failed with status ${status}.${suffix}`;
  }
}

export class TMetricClient {
  private readonly baseUrl: string;

  constructor(
    private readonly token: string,
    baseUrl: string = DEFAULT_BASE_URL,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /**
   * Performs one API v3 call.
   *
   * @param path Endpoint path relative to `/api/v3`, e.g. `/accounts/1/timeentries`.
   * @returns The parsed JSON body, or `undefined` for `204 No Content`.
   * @throws {TMetricApiError} on any non-2xx response, timeout or network failure.
   */
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = "GET", query, body } = options;
    const url = `${this.baseUrl}${API_V3_PREFIX}${path}${buildQuery(query)}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new TMetricApiError(
          `TMetric did not respond within ${REQUEST_TIMEOUT_MS / 1000}s for ${path}. Retry, or narrow the requested date range.`,
          undefined,
          path,
        );
      }
      throw new TMetricApiError(
        `Could not reach TMetric at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}. Check network connectivity and the ${ENV.BASE_URL} setting.`,
        undefined,
        path,
      );
    }

    if (!response.ok) {
      const details = describeErrorBody(await response.text().catch(() => ""));
      throw new TMetricApiError(
        messageForStatus(response.status, path, details),
        response.status,
        path,
        details,
      );
    }

    if (response.status === 204) return undefined as T;

    const text = await response.text();
    if (!text) return undefined as T;

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new TMetricApiError(
        `TMetric returned a non-JSON response for ${path}. This usually means the base URL points at the web app rather than the API.`,
        response.status,
        path,
      );
    }
  }
}
