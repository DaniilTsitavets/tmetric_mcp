/** Shared constants for the TMetric MCP server. */

export const SERVER_NAME = "tmetric-mcp-server";
export const SERVER_VERSION = "1.0.0";

/** Default TMetric host. Override with TMETRIC_BASE_URL for on-premises installs. */
export const DEFAULT_BASE_URL = "https://app.tmetric.com";

/** Path of the REST API v3 relative to the host. */
export const API_V3_PREFIX = "/api/v3";

/** Request timeout for a single API call, in milliseconds. */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Maximum size of a tool's text response. Larger responses are truncated with an
 * explicit message so the agent knows to narrow the query instead of silently
 * losing data.
 */
export const CHARACTER_LIMIT = 25_000;

/** Default page size for list tools. */
export const DEFAULT_PAGE_SIZE = 50;

/** Hard upper bound on how many entries a single bulk call may create. */
export const MAX_BULK_ENTRIES = 50;

/** Environment variable names read at startup. */
export const ENV = {
  TOKEN: "TMETRIC_API_TOKEN",
  ACCOUNT_ID: "TMETRIC_ACCOUNT_ID",
  USER_ID: "TMETRIC_USER_ID",
  BASE_URL: "TMETRIC_BASE_URL",
} as const;
