#!/usr/bin/env node
/**
 * TMetric MCP server.
 *
 * Exposes the TMetric REST API v3 as MCP tools focused on one job: reviewing and
 * filling in tracked time for specific days. Runs over stdio, so it is launched
 * as a subprocess by the MCP client.
 *
 * Required environment: TMETRIC_API_TOKEN.
 * Optional: TMETRIC_ACCOUNT_ID, TMETRIC_USER_ID, TMETRIC_BASE_URL.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_BASE_URL, ENV, SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { TMetricClient } from "./services/client.js";
import { TMetricContext } from "./services/context.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { registerReportTools } from "./tools/reports.js";
import type { ToolDeps } from "./tools/registry.js";
import { registerTimeEntryTools } from "./tools/timeEntries.js";
import { registerTimerTools } from "./tools/timer.js";
import { registerUserTools } from "./tools/user.js";

const HELP = `${SERVER_NAME} ${SERVER_VERSION}

An MCP server for the TMetric time tracking API, speaking MCP over stdio.
It is started by an MCP client, not used interactively.

Environment:
  ${ENV.TOKEN}    Required. Personal API token from the My Profile page in TMetric.
  ${ENV.ACCOUNT_ID}   Optional. Default workspace id when a tool call omits account_id.
  ${ENV.USER_ID}      Optional. Default user id when a tool call omits user_id.
  ${ENV.BASE_URL}     Optional. Host override for on-premises installs (default ${DEFAULT_BASE_URL}).

Client configuration (Claude Code):
  claude mcp add tmetric --env ${ENV.TOKEN}=<token> -- node ${process.cwd()}/dist/index.js
`;

/** Builds the server with every tool group registered. */
export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Tools for reviewing and filling in TMetric time tracking. Start with tmetric_get_current_user to learn the workspace id and its rules (some workspaces require a project or a description on every entry). " +
        "Resolve names to ids with tmetric_list_projects, tmetric_list_tasks and tmetric_list_tags. " +
        "Read a day with tmetric_list_time_entries before writing to it, then log work with tmetric_create_time_entry, or tmetric_create_time_entries_bulk when filling a whole day or week at once. " +
        "Durations are enough: omit start_time and entries are appended after the time already logged that day. Pass dry_run=true to preview a layout before committing it.",
    },
  );

  registerUserTools(server, deps);
  registerCatalogTools(server, deps);
  registerTimeEntryTools(server, deps);
  registerTimerTools(server, deps);
  registerReportTools(server, deps);

  return server;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }

  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    process.stdout.write(`${SERVER_NAME} ${SERVER_VERSION}\n`);
    return;
  }

  const token = process.env[ENV.TOKEN]?.trim();
  if (!token) {
    // stdio servers must never write to stdout: it carries the JSON-RPC stream.
    console.error(
      `ERROR: ${ENV.TOKEN} is not set. Generate a personal API token on the My Profile page in TMetric ` +
        `(it is valid for one year) and pass it to this server's environment. Run with --help for details.`,
    );
    process.exit(1);
  }

  const client = new TMetricClient(token, process.env[ENV.BASE_URL]?.trim() || DEFAULT_BASE_URL);
  const server = createServer({ client, context: new TMetricContext(client) });

  await server.connect(new StdioServerTransport());
  console.error(`${SERVER_NAME} ${SERVER_VERSION} ready on stdio.`);
}

main().catch((error: unknown) => {
  console.error(`Fatal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
