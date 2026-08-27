/**
 * Reporting tool: per-project totals over a period.
 *
 * Where tmetric_list_time_entries answers "what did I do", this answers "how much
 * went where", which is what timesheet and invoice checks actually need.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { accountIdSchema, dateSchema, responseFormatSchema } from "../schemas/common.js";
import { TMetricApiError } from "../services/client.js";
import type { TMetricProjectReportItem } from "../types.js";
import { formatDuration, formatSeconds, resolveDate, toDecimalHours } from "../utils/datetime.js";
import { buildToolResult, escapeCell, type ResponseFormat } from "../utils/format.js";
import { defineTool, READ_ONLY, type ToolDeps } from "./registry.js";

const inputSchema = z
  .object({
    start_date: dateSchema.describe("First day of the period (YYYY-MM-DD, or 'today' / 'yesterday')."),
    end_date: dateSchema.describe("Last day of the period, inclusive."),
    user_ids: z
      .array(z.number().int().min(0))
      .max(50)
      .optional()
      .describe("Restrict to these users. 0 means the current user. Omit for everyone you may see."),
    project_ids: z.array(z.number().int().positive()).max(50).optional().describe("Restrict to these projects."),
    client_ids: z.array(z.number().int().positive()).max(50).optional().describe("Restrict to these clients."),
    include_done: z.boolean().default(true).describe("Include projects marked as done."),
    account_id: accountIdSchema,
    response_format: responseFormatSchema,
  })
  .strict();

const projectTotalSchema = z.object({
  project_id: z.number().int().optional(),
  project: z.string(),
  client: z.string().optional(),
  total_hours: z.number(),
  total_human: z.string(),
  billable_hours: z.number().optional(),
  billable_amount: z.number().optional(),
  currency: z.string().optional(),
  share_percent: z.number().describe("This project's share of the period's total time."),
});

const outputSchema = {
  start_date: z.string(),
  end_date: z.string(),
  account_id: z.number().int(),
  project_count: z.number().int(),
  total_hours: z.number(),
  total_human: z.string(),
  billable_hours: z.number().optional(),
  projects: z.array(projectTotalSchema).describe("Per-project totals, largest first."),
} as const;

type Output = {
  start_date: string;
  end_date: string;
  account_id: number;
  project_count: number;
  total_hours: number;
  total_human: string;
  billable_hours?: number;
  projects: Array<z.infer<typeof projectTotalSchema>>;
};

function render(output: Output): string {
  const lines = [
    `# Time summary ${output.start_date} → ${output.end_date}`,
    "",
    `**${output.total_human}** across ${output.project_count} project(s).`,
    ...(output.billable_hours !== undefined ? [`Billable: ${formatDuration(output.billable_hours * 60)}.`] : []),
    "",
  ];

  if (output.projects.length === 0) {
    lines.push("No time was tracked in this period.");
    return lines.join("\n");
  }

  lines.push("| project | client | time | share | billable |", "| --- | --- | --- | --- | --- |");
  for (const project of output.projects) {
    const billable =
      project.billable_amount !== undefined
        ? `${project.billable_amount} ${project.currency ?? ""}`.trim()
        : project.billable_hours !== undefined
          ? formatDuration(project.billable_hours * 60)
          : "—";
    lines.push(
      `| ${escapeCell(project.project)} | ${escapeCell(project.client ?? "—")} | ${project.total_human} | ${project.share_percent}% | ${billable} |`,
    );
  }
  return lines.join("\n");
}

export function registerReportTools(server: McpServer, deps: ToolDeps): void {
  defineTool(server, deps, {
    name: "tmetric_get_time_summary",
    title: "Summarise tracked time by project",
    description: `Return how much time went to each project over a period, with each project's share of the total.

Use it to sanity-check a filled-in week ("did the 40 hours land where they should?") or to answer "how much did we spend on this client last month". For the individual entries behind these numbers, use tmetric_list_time_entries.

Args:
  - start_date (string, required): first day, YYYY-MM-DD or 'today' / 'yesterday'
  - end_date (string, required): last day, inclusive
  - user_ids (number[]): restrict to these users; 0 means yourself
  - project_ids (number[]): restrict to these projects
  - client_ids (number[]): restrict to these clients
  - include_done (boolean): include projects marked done (default: true)
  - account_id (number): workspace id (default: your active workspace)
  - response_format ('markdown' | 'json')

Returns:
  {
    "start_date": string, "end_date": string, "account_id": number,
    "project_count": number,
    "total_hours": number, "total_human": string, "billable_hours": number,
    "projects": [
      { "project_id": number, "project": string, "client": string,
        "total_hours": number, "total_human": string,
        "billable_hours": number, "billable_amount": number, "currency": string,
        "share_percent": number }
    ]
  }

Examples:
  - Use when: "how did my hours split across projects last week" -> {"start_date": "2026-08-17", "end_date": "2026-08-21", "user_ids": [0]}
  - Use when: checking a month for one client -> {"start_date": "2026-07-01", "end_date": "2026-07-31", "client_ids": [90001]}
  - Don't use when: you need entry ids to correct something (use tmetric_list_time_entries)

Error handling:
  - Financial fields are omitted when your role has no access to rates and amounts.
  - Returns a permission error when requesting other users' data without the right to see it.`,
    inputSchema,
    outputSchema,
    annotations: READ_ONLY,
    handler: async (args, { client, context }) => {
      const accountId = await context.resolveAccountId(args.account_id);
      const startDate = resolveDate(args.start_date, "start_date");
      const endDate = resolveDate(args.end_date, "end_date");

      if (endDate < startDate) {
        throw new TMetricApiError(
          `end_date (${endDate}) is before start_date (${startDate}).`,
          undefined,
          "get_time_summary",
        );
      }

      const rows = await client.request<TMetricProjectReportItem[]>(`/accounts/${accountId}/reports/projects`, {
        query: {
          startDate,
          endDate,
          userId: args.user_ids,
          projectId: args.project_ids,
          clientId: args.client_ids,
          includeDone: args.include_done,
        },
      });

      const items = rows ?? [];
      const totalSeconds = items.reduce((sum, item) => sum + (item.totalSeconds ?? 0), 0);
      const billableSeconds = items.reduce((sum, item) => sum + (item.billableSeconds ?? 0), 0);

      const projects = items
        .map((item) => ({
          ...(item.project?.id !== undefined ? { project_id: item.project.id } : {}),
          project: item.project?.name ?? "(no project)",
          ...(item.project?.client?.name ? { client: item.project.client.name } : {}),
          total_hours: toDecimalHours((item.totalSeconds ?? 0) / 60),
          total_human: formatSeconds(item.totalSeconds ?? 0),
          ...(item.billableSeconds !== undefined
            ? { billable_hours: toDecimalHours(item.billableSeconds / 60) }
            : {}),
          ...(item.billableAmount !== undefined ? { billable_amount: item.billableAmount } : {}),
          ...(item.billableCurrency ? { currency: item.billableCurrency } : {}),
          share_percent:
            totalSeconds > 0 ? Math.round(((item.totalSeconds ?? 0) / totalSeconds) * 1000) / 10 : 0,
        }))
        .sort((a, b) => b.total_hours - a.total_hours);

      const output: Output = {
        start_date: startDate,
        end_date: endDate,
        account_id: accountId,
        project_count: projects.length,
        total_hours: toDecimalHours(totalSeconds / 60),
        total_human: formatSeconds(totalSeconds),
        ...(billableSeconds > 0 ? { billable_hours: toDecimalHours(billableSeconds / 60) } : {}),
        projects,
      };

      return buildToolResult(output, render, args.response_format as ResponseFormat, (value) => {
        if (value.projects.length <= 1) return null;
        return { ...value, projects: value.projects.slice(0, Math.max(1, Math.floor(value.projects.length / 2))) };
      });
    },
  });
}
