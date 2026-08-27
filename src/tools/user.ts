/**
 * Identity tool. This is the entry point for any session: it yields the workspace
 * id, the user id, the workspace's time-tracking rules and the timezone that all
 * other tools implicitly work in.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TMetricUser } from "../types.js";
import { buildToolResult, joinParts, type ResponseFormat } from "../utils/format.js";
import { responseFormatSchema } from "../schemas/common.js";
import { defineTool, READ_ONLY, type ToolDeps } from "./registry.js";

const inputSchema = z
  .object({
    refresh: z
      .boolean()
      .default(false)
      .describe("Re-fetch the profile instead of using the value cached for this session."),
    response_format: responseFormatSchema,
  })
  .strict();

const workspaceSchema = z.object({
  id: z.number().int(),
  name: z.string().optional(),
  is_active: z.boolean(),
  first_week_day: z.number().int().optional().describe("0 = Sunday … 6 = Saturday."),
  can_edit_time_manually: z.boolean().optional(),
  requires_project: z.boolean().optional(),
  requires_description: z.boolean().optional(),
  requires_task: z.boolean().optional(),
  requires_tags: z.boolean().optional(),
  can_create_projects: z.boolean().optional(),
  can_create_tasks: z.boolean().optional(),
  can_create_tags: z.boolean().optional(),
  can_view_team_time: z.boolean().optional(),
});

const outputSchema = {
  user_id: z.number().int().describe("Your TMetric user id; pass as user_id where a tool accepts one."),
  name: z.string().optional(),
  email: z.string().optional(),
  timezone: z.string().optional().describe("IANA timezone the workspace timestamps are interpreted in."),
  default_account_id: z
    .number()
    .int()
    .optional()
    .describe("Workspace id used when a tool call omits account_id."),
  workspaces: z.array(workspaceSchema).describe("Every workspace you can access."),
} as const;

type Output = {
  user_id: number;
  name?: string;
  email?: string;
  timezone?: string;
  default_account_id?: number;
  workspaces: Array<z.infer<typeof workspaceSchema>>;
};

function mapProfile(profile: TMetricUser, defaultAccountId: number | undefined): Output {
  return {
    user_id: profile.id,
    ...(profile.name ? { name: profile.name } : {}),
    ...(profile.email ? { email: profile.email } : {}),
    ...(profile.timeZone?.ianaId ? { timezone: profile.timeZone.ianaId } : {}),
    ...(defaultAccountId !== undefined ? { default_account_id: defaultAccountId } : {}),
    workspaces: (profile.accounts ?? []).map((account) => {
      const rules = account.timeTracking ?? {};
      return {
        id: account.id,
        ...(account.name ? { name: account.name } : {}),
        is_active: account.id === defaultAccountId,
        ...(account.firstWeekDay !== undefined ? { first_week_day: account.firstWeekDay } : {}),
        ...(rules.allowManualEditing !== undefined ? { can_edit_time_manually: rules.allowManualEditing } : {}),
        ...(rules.requireProject !== undefined ? { requires_project: rules.requireProject } : {}),
        ...(rules.requireDescription !== undefined ? { requires_description: rules.requireDescription } : {}),
        ...(rules.requireTask !== undefined ? { requires_task: rules.requireTask } : {}),
        ...(rules.requireTags !== undefined ? { requires_tags: rules.requireTags } : {}),
        ...(rules.allowNewProject !== undefined ? { can_create_projects: rules.allowNewProject } : {}),
        ...(rules.allowNewTask !== undefined ? { can_create_tasks: rules.allowNewTask } : {}),
        ...(rules.allowNewTags !== undefined ? { can_create_tags: rules.allowNewTags } : {}),
        ...(rules.allowTeamView !== undefined ? { can_view_team_time: rules.allowTeamView } : {}),
      };
    }),
  };
}

function render(output: Output): string {
  const lines = [
    `# ${output.name ?? "TMetric user"} (user_id: ${output.user_id})`,
    "",
    joinParts([output.email, output.timezone ? `timezone: ${output.timezone}` : undefined]),
    "",
    `## Workspaces (${output.workspaces.length})`,
    "",
  ];

  for (const workspace of output.workspaces) {
    lines.push(`### ${workspace.name ?? "(unnamed)"} (account_id: ${workspace.id})${workspace.is_active ? " — default" : ""}`);

    const required = joinParts(
      [
        workspace.requires_project ? "project" : undefined,
        workspace.requires_task ? "task" : undefined,
        workspace.requires_description ? "description" : undefined,
        workspace.requires_tags ? "tags" : undefined,
      ],
      ", ",
    );
    lines.push(`- Required on every entry: ${required || "nothing"}`);
    lines.push(
      `- Manual time editing: ${workspace.can_edit_time_manually === false ? "**disabled** (only start/stop the timer)" : "allowed"}`,
    );

    const canCreate = joinParts(
      [
        workspace.can_create_projects ? "projects" : undefined,
        workspace.can_create_tasks ? "tasks" : undefined,
        workspace.can_create_tags ? "tags" : undefined,
      ],
      ", ",
    );
    lines.push(`- You can create: ${canCreate || "nothing new"}`);
    if (workspace.can_view_team_time) lines.push("- You can read other team members' time entries.");
    lines.push("");
  }

  return lines.join("\n");
}

export function registerUserTools(server: McpServer, deps: ToolDeps): void {
  defineTool(server, deps, {
    name: "tmetric_get_current_user",
    title: "Get TMetric profile and workspaces",
    description: `Return the authenticated TMetric user together with every workspace they can access and that workspace's time-tracking rules.

Call this first in a session. It supplies the account_id and user_id that other tools default to, the workspace timezone that all timestamps are interpreted in, and the rules that decide whether a write will be accepted (for example whether a project is mandatory on each entry, or whether manual editing is disabled).

Args:
  - refresh (boolean): re-fetch instead of reusing the cached profile (default: false)
  - response_format ('markdown' | 'json'): output format (default: 'markdown')

Returns:
  {
    "user_id": number,                 // your TMetric user id
    "name": string,
    "email": string,
    "timezone": string,                // IANA id, e.g. "Europe/Warsaw"
    "default_account_id": number,      // workspace used when account_id is omitted
    "workspaces": [
      {
        "id": number,                  // pass as account_id
        "name": string,
        "is_active": boolean,
        "first_week_day": number,      // 0 = Sunday … 6 = Saturday
        "can_edit_time_manually": boolean,
        "requires_project": boolean,
        "requires_description": boolean,
        "requires_task": boolean,
        "requires_tags": boolean,
        "can_create_projects": boolean,
        "can_create_tasks": boolean,
        "can_create_tags": boolean,
        "can_view_team_time": boolean
      }
    ]
  }

Examples:
  - Use when: starting to log time and you need the workspace id -> {}
  - Use when: a write failed with "requires a project" and you want to confirm the rule -> {"response_format": "json"}
  - Don't use when: you only need the list of projects (use tmetric_list_projects instead)

Error handling:
  - Returns an authentication error if TMETRIC_API_TOKEN is missing, expired or revoked.`,
    inputSchema,
    outputSchema,
    annotations: READ_ONLY,
    handler: async (args, { context }) => {
      const profile = await context.getProfile(args.refresh);
      const defaultAccountId = await context.resolveAccountId().catch(() => undefined);
      const output = mapProfile(profile, defaultAccountId);
      return buildToolResult(output, render, args.response_format as ResponseFormat);
    },
  });
}
