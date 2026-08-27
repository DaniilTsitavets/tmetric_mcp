/**
 * Read-only catalogue tools: the projects, clients, tags and tasks that a time
 * entry can reference. An agent normally calls these to translate the names a
 * human used ("the Acme redesign") into the ids the write tools need.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  accountIdSchema,
  limitSchema,
  offsetSchema,
  pageMetaShape,
  responseFormatSchema,
  userIdSchema,
} from "../schemas/common.js";
import type {
  TMetricClientBasic,
  TMetricTask,
  TMetricTimeEntryProject,
  TMetricTimeEntryTag,
} from "../types.js";
import { normalizeApiDateTime } from "../utils/datetime.js";
import {
  buildToolResult,
  escapeCell,
  halveList,
  joinParts,
  paginate,
  type PageMeta,
  type ResponseFormat,
} from "../utils/format.js";
import { mapTimeEntryProject, mapTimeEntryTag } from "../utils/mappers.js";
import { defineTool, READ_ONLY, type ToolDeps } from "./registry.js";

/** Case-insensitive substring match used by the `search` parameter of each tool. */
function matches(haystack: string | undefined, needle: string | undefined): boolean {
  if (!needle) return true;
  return (haystack ?? "").toLowerCase().includes(needle.toLowerCase());
}

/* ------------------------------------------------------------------ projects */

const projectsInput = z
  .object({
    search: z.string().min(1).max(200).optional().describe("Case-insensitive substring filter on project or client name."),
    only_billable: z.boolean().optional().describe("Keep only projects flagged as billable."),
    account_id: accountIdSchema,
    user_id: userIdSchema,
    limit: limitSchema,
    offset: offsetSchema,
    response_format: responseFormatSchema,
  })
  .strict();

const projectItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  client: z.string().optional(),
  client_id: z.number().int().optional(),
  is_billable: z.boolean().optional(),
  status: z.string().optional(),
  last_used: z.string().optional().describe("When you last logged time to this project (local time)."),
});

const projectsOutput = {
  ...pageMetaShape,
  projects: z.array(projectItemSchema),
} as const;

type ProjectsOutput = PageMeta & { projects: Array<z.infer<typeof projectItemSchema>> };

function renderProjects(output: ProjectsOutput): string {
  if (output.projects.length === 0) {
    return "No projects available for time tracking match the filter.";
  }
  const lines = [
    `# Projects available for time tracking (${output.count} of ${output.total})`,
    "",
    "| id | project | client | billable | last used |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const project of output.projects) {
    lines.push(
      `| ${project.id} | ${escapeCell(project.name)} | ${escapeCell(project.client ?? "—")} | ${project.is_billable ? "yes" : "no"} | ${project.last_used?.slice(0, 10) ?? "—"} |`,
    );
  }
  if (output.has_more) lines.push("", `More projects available — call again with offset=${output.next_offset}.`);
  if (output.truncation_message) lines.push("", output.truncation_message);
  return lines.join("\n");
}

/* ------------------------------------------------------------------- clients */

const clientsInput = z
  .object({
    search: z.string().min(1).max(200).optional().describe("Case-insensitive substring filter on the client name."),
    account_id: accountIdSchema,
    limit: limitSchema,
    offset: offsetSchema,
    response_format: responseFormatSchema,
  })
  .strict();

const clientItemSchema = z.object({ id: z.number().int(), name: z.string() });

const clientsOutput = {
  ...pageMetaShape,
  clients: z.array(clientItemSchema),
} as const;

type ClientsOutput = PageMeta & { clients: Array<z.infer<typeof clientItemSchema>> };

function renderClients(output: ClientsOutput): string {
  if (output.clients.length === 0) return "No clients match the filter.";
  const lines = [`# Clients (${output.count} of ${output.total})`, ""];
  for (const client of output.clients) lines.push(`- ${escapeCell(client.name)} (id: ${client.id})`);
  if (output.has_more) lines.push("", `More clients available — call again with offset=${output.next_offset}.`);
  return lines.join("\n");
}

/* ---------------------------------------------------------------------- tags */

const tagsInput = z
  .object({
    project_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Restrict to tags usable on this project. Omit for every tag in the workspace."),
    only_work_types: z.boolean().optional().describe("Keep only work types (billing categories) rather than plain tags."),
    account_id: accountIdSchema,
    limit: limitSchema,
    offset: offsetSchema,
    response_format: responseFormatSchema,
  })
  .strict();

const tagItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  is_work_type: z.boolean(),
  is_work_type_billable: z.boolean().optional(),
});

const tagsOutput = {
  ...pageMetaShape,
  tags: z.array(tagItemSchema),
} as const;

type TagsOutput = PageMeta & { tags: Array<z.infer<typeof tagItemSchema>> };

function renderTags(output: TagsOutput): string {
  if (output.tags.length === 0) return "No tags match the filter.";
  const lines = [`# Tags (${output.count} of ${output.total})`, ""];
  for (const tag of output.tags) {
    lines.push(`- ${escapeCell(tag.name)} (id: ${tag.id})${tag.is_work_type ? " — work type" : ""}`);
  }
  if (output.has_more) lines.push("", `More tags available — call again with offset=${output.next_offset}.`);
  return lines.join("\n");
}

/* --------------------------------------------------------------------- tasks */

const tasksInput = z
  .object({
    search: z.string().min(1).max(200).optional().describe("Case-insensitive substring filter on the task name."),
    project_id: z.number().int().positive().optional().describe("Restrict to tasks of this project."),
    assignee_id: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Restrict to tasks assigned to this user id; 0 means unassigned."),
    completed: z.boolean().optional().describe("false returns open tasks, true returns done tasks, omit for both."),
    source: z
      .enum(["internal", "external", "all"])
      .default("all")
      .describe("'internal' for tasks created in TMetric, 'external' for tasks imported from an integration."),
    due_after: z.string().optional().describe("Keep tasks whose due date is on or after this YYYY-MM-DD date."),
    due_before: z.string().optional().describe("Keep tasks whose due date is on or before this YYYY-MM-DD date."),
    account_id: accountIdSchema,
    limit: limitSchema,
    offset: offsetSchema,
    response_format: responseFormatSchema,
  })
  .strict();

const taskItemSchema = z.object({
  id: z.number().int().optional(),
  name: z.string(),
  project: z.string().optional(),
  project_id: z.number().int().optional(),
  assignee: z.string().optional(),
  is_completed: z.boolean().optional(),
  due_date: z.string().optional(),
  external_link: z.string().optional(),
});

const tasksOutput = {
  ...pageMetaShape,
  tasks: z.array(taskItemSchema),
} as const;

type TasksOutput = PageMeta & { tasks: Array<z.infer<typeof taskItemSchema>> };

function renderTasks(output: TasksOutput): string {
  if (output.tasks.length === 0) return "No tasks match the filter.";
  const lines = [`# Tasks (${output.count} of ${output.total})`, ""];
  for (const task of output.tasks) {
    const meta = joinParts([
      task.project ? `project: ${task.project}` : undefined,
      task.assignee ? `assignee: ${task.assignee}` : undefined,
      task.due_date ? `due: ${task.due_date.slice(0, 10)}` : undefined,
      task.is_completed ? "done" : undefined,
      task.id !== undefined ? `task_id: ${task.id}` : undefined,
    ]);
    lines.push(`- ${escapeCell(task.name)}${meta ? `\n  ${meta}` : ""}`);
  }
  if (output.has_more) lines.push("", `More tasks available — call again with offset=${output.next_offset}.`);
  if (output.truncation_message) lines.push("", output.truncation_message);
  return lines.join("\n");
}

/* ---------------------------------------------------------------- registration */

export function registerCatalogTools(server: McpServer, deps: ToolDeps): void {
  defineTool(server, deps, {
    name: "tmetric_list_projects",
    title: "List TMetric projects",
    description: `List the projects the given user may book time to, newest-used first.

Use this to turn a project name mentioned by a human into the project_id that the time-entry tools need. The 'last_used' field makes it easy to spot the projects actually being worked on.

Args:
  - search (string): case-insensitive substring filter on project or client name
  - only_billable (boolean): keep only billable projects
  - account_id (number): workspace id (default: your active workspace)
  - user_id (number): whose available projects to list (default: yourself)
  - limit (number): 1-500 items (default: 50)
  - offset (number): items to skip (default: 0)
  - response_format ('markdown' | 'json')

Returns:
  {
    "total": number, "count": number, "offset": number, "has_more": boolean,
    "next_offset": number,               // present when has_more is true
    "projects": [
      { "id": number, "name": string, "client": string, "client_id": number,
        "is_billable": boolean, "status": string, "last_used": string }
    ]
  }

Examples:
  - Use when: "log 3h to the Acme project" and you need its id -> {"search": "acme"}
  - Use when: you want the projects you touched recently -> {"limit": 10}
  - Don't use when: you need what you already logged (use tmetric_list_time_entries)

Error handling:
  - Returns an empty list with an explanatory message when nothing matches 'search'.`,
    inputSchema: projectsInput,
    outputSchema: projectsOutput,
    annotations: READ_ONLY,
    handler: async (args, { client, context }) => {
      const { accountId, userId } = await context.resolve(args.account_id, args.user_id);
      const raw = await client.request<TMetricTimeEntryProject[]>(`/accounts/${accountId}/timeentries/projects`, {
        query: { userId },
      });

      const filtered = (raw ?? [])
        .filter((project) => matches(project.name, args.search) || matches(project.client?.name, args.search))
        .filter((project) => (args.only_billable ? project.isBillable === true : true))
        .sort((a, b) => (b.recentUsageTime ?? "").localeCompare(a.recentUsageTime ?? ""));

      const { page, meta } = paginate(filtered.map(mapTimeEntryProject), args.limit, args.offset);
      const output: ProjectsOutput = { ...meta, projects: page };
      return buildToolResult(output, renderProjects, args.response_format as ResponseFormat, halveList("projects"));
    },
  });

  defineTool(server, deps, {
    name: "tmetric_list_clients",
    title: "List TMetric clients",
    description: `List every client in the workspace.

Clients group projects; use this when a human refers to work by customer name rather than project name, then filter projects by that client.

Args:
  - search (string): case-insensitive substring filter on the client name
  - account_id (number): workspace id (default: your active workspace)
  - limit (number): 1-500 items (default: 50)
  - offset (number): items to skip (default: 0)
  - response_format ('markdown' | 'json')

Returns:
  {
    "total": number, "count": number, "offset": number, "has_more": boolean,
    "clients": [ { "id": number, "name": string } ]
  }

Examples:
  - Use when: "how much did we do for Acme last month" -> {"search": "acme"}
  - Don't use when: you already know the project (use tmetric_list_projects)`,
    inputSchema: clientsInput,
    outputSchema: clientsOutput,
    annotations: READ_ONLY,
    handler: async (args, { client, context }) => {
      const accountId = await context.resolveAccountId(args.account_id);
      const raw = await client.request<TMetricClientBasic[]>(`/accounts/${accountId}/clients`);

      const filtered = (raw ?? [])
        .filter((item) => matches(item.name, args.search))
        .map((item) => ({ id: item.id ?? 0, name: item.name ?? "(unnamed)" }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const { page, meta } = paginate(filtered, args.limit, args.offset);
      const output: ClientsOutput = { ...meta, clients: page };
      return buildToolResult(output, renderClients, args.response_format as ResponseFormat, halveList("clients"));
    },
  });

  defineTool(server, deps, {
    name: "tmetric_list_tags",
    title: "List TMetric tags and work types",
    description: `List the tags and work types that can be attached to a time entry.

A work type is a special tag that drives billing rates. Workspaces that set 'requires_tags' will reject entries without one, so check tmetric_get_current_user when a write is refused.

Args:
  - project_id (number): restrict to tags usable on this project
  - only_work_types (boolean): keep only work types
  - account_id (number): workspace id (default: your active workspace)
  - limit (number): 1-500 items (default: 50)
  - offset (number): items to skip (default: 0)
  - response_format ('markdown' | 'json')

Returns:
  {
    "total": number, "count": number, "offset": number, "has_more": boolean,
    "tags": [
      { "id": number, "name": string, "is_work_type": boolean, "is_work_type_billable": boolean }
    ]
  }

Examples:
  - Use when: an entry needs a work type -> {"project_id": 500001, "only_work_types": true}
  - Use when: you want every tag in the workspace -> {}`,
    inputSchema: tagsInput,
    outputSchema: tagsOutput,
    annotations: READ_ONLY,
    handler: async (args, { client, context }) => {
      const accountId = await context.resolveAccountId(args.account_id);
      const raw = await client.request<TMetricTimeEntryTag[]>(`/accounts/${accountId}/timeentries/tags`, {
        query: { projectId: args.project_id },
      });

      const filtered = (raw ?? [])
        .map(mapTimeEntryTag)
        .filter((tag) => (args.only_work_types ? tag.is_work_type : true))
        .sort((a, b) => a.name.localeCompare(b.name));

      const { page, meta } = paginate(filtered, args.limit, args.offset);
      const output: TagsOutput = { ...meta, tags: page };
      return buildToolResult(output, renderTags, args.response_format as ResponseFormat, halveList("tags"));
    },
  });

  defineTool(server, deps, {
    name: "tmetric_list_tasks",
    title: "List TMetric tasks",
    description: `List tasks in the workspace, optionally narrowed by project, assignee, completion state or due date.

Linking a time entry to an existing task keeps reporting consistent. Tasks imported from an integration (Jira, GitHub, …) carry an 'external_link' back to the source issue.

Args:
  - search (string): case-insensitive substring filter on the task name
  - project_id (number): restrict to one project
  - assignee_id (number): restrict to one assignee; 0 means unassigned
  - completed (boolean): false = open tasks, true = done tasks, omit for both
  - source ('internal' | 'external' | 'all'): where the task came from (default: 'all')
  - due_after (string), due_before (string): YYYY-MM-DD due-date bounds
  - account_id (number): workspace id (default: your active workspace)
  - limit (number): 1-500 items (default: 50)
  - offset (number): items to skip (default: 0)
  - response_format ('markdown' | 'json')

Returns:
  {
    "total": number, "count": number, "offset": number, "has_more": boolean,
    "tasks": [
      { "id": number, "name": string, "project": string, "project_id": number,
        "assignee": string, "is_completed": boolean, "due_date": string, "external_link": string }
    ]
  }

Examples:
  - Use when: "log time against the login bug" -> {"search": "login", "completed": false}
  - Use when: reviewing what is still open on a project -> {"project_id": 500001, "completed": false}
  - Don't use when: you just need a free-text description on the entry — pass 'note' to the create tool instead of creating a task.`,
    inputSchema: tasksInput,
    outputSchema: tasksOutput,
    annotations: READ_ONLY,
    handler: async (args, { client, context }) => {
      const accountId = await context.resolveAccountId(args.account_id);
      const raw = await client.request<TMetricTask[]>(`/accounts/${accountId}/tasks`, {
        query: {
          Assignee: args.assignee_id,
          ProjectList: args.project_id === undefined ? undefined : [args.project_id],
          Completed: args.completed,
          Source: args.source,
          AfterDate: args.due_after,
          BeforeDate: args.due_before,
        },
      });

      const filtered = (raw ?? [])
        .filter((task) => matches(task.name, args.search))
        .map((task) => ({
          ...(task.id !== undefined ? { id: task.id } : {}),
          name: task.name ?? "(unnamed)",
          ...(task.project?.name ? { project: task.project.name } : {}),
          ...(task.project?.id !== undefined ? { project_id: task.project.id } : {}),
          ...(task.assignee?.name ? { assignee: task.assignee.name } : {}),
          ...(task.isCompleted !== undefined ? { is_completed: task.isCompleted } : {}),
          ...(task.dueDate ? { due_date: normalizeApiDateTime(task.dueDate) ?? task.dueDate } : {}),
          ...(task.externalLink?.link ? { external_link: task.externalLink.link } : {}),
        }));

      const { page, meta } = paginate(filtered, args.limit, args.offset);
      const output: TasksOutput = { ...meta, tasks: page };
      return buildToolResult(output, renderTasks, args.response_format as ResponseFormat, halveList("tasks"));
    },
  });
}
