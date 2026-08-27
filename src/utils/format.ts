/**
 * Shared response construction: pagination, Markdown/JSON rendering, size capping
 * and error formatting. Every tool funnels its output through here so that the
 * shape of results stays consistent across the server.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CHARACTER_LIMIT } from "../constants.js";
import { TMetricApiError } from "../services/client.js";

export const RESPONSE_FORMATS = ["markdown", "json"] as const;
export type ResponseFormat = (typeof RESPONSE_FORMATS)[number];

/** Pagination metadata attached to every list result. */
export type PageMeta = {
  total: number;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
  truncated?: boolean;
  truncation_message?: string;
};

/** Slices `items` and describes the slice. Sorting must happen before this call. */
export function paginate<T>(items: T[], limit: number, offset: number): { page: T[]; meta: PageMeta } {
  const page = items.slice(offset, offset + limit);
  const consumed = offset + page.length;
  const hasMore = consumed < items.length;
  return {
    page,
    meta: {
      total: items.length,
      count: page.length,
      offset,
      has_more: hasMore,
      ...(hasMore ? { next_offset: consumed } : {}),
    },
  };
}

/**
 * Renders a tool result, shrinking it while it exceeds {@link CHARACTER_LIMIT}.
 *
 * @param output Structured payload returned as `structuredContent`.
 * @param render Markdown renderer used when `format` is `markdown`.
 * @param shrink Optional reducer that drops data to fit; returning `null` means
 *   nothing more can be dropped and the result is emitted as-is.
 */
export function buildToolResult<T extends Record<string, unknown>>(
  output: T,
  render: (value: T) => string,
  format: ResponseFormat,
  shrink?: (value: T) => T | null,
): CallToolResult {
  let current = output;
  let text = format === "json" ? JSON.stringify(current, null, 2) : render(current);

  while (text.length > CHARACTER_LIMIT && shrink) {
    const smaller = shrink(current);
    if (!smaller) break;
    current = smaller;
    text = format === "json" ? JSON.stringify(current, null, 2) : render(current);
  }

  return {
    content: [{ type: "text", text }],
    structuredContent: current,
  };
}

/**
 * Builds a shrinker that halves the array stored under `key` and records why the
 * response is incomplete.
 */
export function halveList<T extends Record<string, unknown>>(key: keyof T & string) {
  return (value: T): T | null => {
    const items = value[key];
    if (!Array.isArray(items) || items.length <= 1) return null;
    const kept = items.slice(0, Math.max(1, Math.floor(items.length / 2)));
    return {
      ...value,
      [key]: kept,
      count: kept.length,
      truncated: true,
      truncation_message: `Response was too large and was truncated from ${items.length} to ${kept.length} items. Narrow the date range or use 'limit'/'offset' to page through the rest.`,
    } as T;
  };
}

/** Formats a thrown value as a tool error, preserving actionable API guidance. */
export function errorResult(error: unknown): CallToolResult {
  const message =
    error instanceof TMetricApiError || error instanceof Error
      ? error.message
      : `Unexpected error: ${String(error)}`;

  return {
    isError: true,
    content: [{ type: "text", text: message.startsWith("TMetric") ? message : `Error: ${message}` }],
  };
}

/** Escapes the pipe character so free-form text cannot break a Markdown table. */
export function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n+/g, " ");
}

/** Joins non-empty parts with a separator, dropping blanks. */
export function joinParts(parts: Array<string | undefined | null>, separator = " · "): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join(separator);
}
