/**
 * Live timer tools.
 *
 * Retroactive logging is this server's main job, but a forgotten running timer
 * blocks new entries from being appended to a day, so reading and stopping the
 * timer belongs to the same workflow.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { accountIdSchema, responseFormatSchema, timeEntrySchema, userIdSchema } from "../schemas/common.js";
import { TMetricApiError } from "../services/client.js";
import type { TMetricTimeEntry } from "../types.js";
import { formatDuration, normalizeApiDateTime, toLocalDateString } from "../utils/datetime.js";
import { buildToolResult, escapeCell, type ResponseFormat } from "../utils/format.js";
import { mapTimeEntry, renderTimeEntryLine } from "../utils/mappers.js";
import { CREATES, defineTool, READ_ONLY, UPDATES, type ToolDeps } from "./registry.js";

/** Current wall-clock instant as the naive local timestamp the API expects. */
function nowLocalTimestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${toLocalDateString(now)}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

const activeInput = z
  .object({
    account_id: accountIdSchema,
    user_id: userIdSchema,
    response_format: responseFormatSchema,
  })
  .strict();

const activeOutput = {
  is_running: z.boolean().describe("True when a timer is currently counting."),
  entry: timeEntrySchema.optional().describe("The latest entry; running when 'is_running' is true."),
  message: z.string(),
} as const;

const startInput = z
  .object({
    note: z.string().max(2000).optional().describe("What you are starting to work on."),
    project_id: z.number().int().positive().optional().describe("Project to book the running time to."),
    task_id: z.number().int().positive().optional(),
    task_name: z.string().max(400).optional().describe("Task to link, created when it does not exist and the workspace allows it."),
    tag_ids: z.array(z.number().int().positive()).max(20).optional(),
    tag_names: z.array(z.string().min(1).max(100)).max(20).optional(),
    is_billable: z.boolean().optional(),
    account_id: accountIdSchema,
    user_id: userIdSchema,
    response_format: responseFormatSchema,
  })
  .strict();

const startOutput = {
  started: z.boolean(),
  started_at: z.string().describe("Local timestamp the timer started at."),
  entry: timeEntrySchema.optional(),
  message: z.string(),
} as const;

const stopInput = z
  .object({
    account_id: accountIdSchema,
    user_id: userIdSchema,
    response_format: responseFormatSchema,
  })
  .strict();

const stopOutput = {
  stopped: z.boolean().describe("False when there was nothing running."),
  entry: timeEntrySchema.optional().describe("The entry as stored after being closed."),
  message: z.string(),
} as const;

/** Reads the latest entry on the user's timeline, or `undefined` when there is none. */
async function fetchLatest(
  deps: ToolDeps,
  accountId: number,
  userId: number,
): Promise<TMetricTimeEntry | undefined> {
  const latest = await deps.client.request<TMetricTimeEntry | null>(
    `/accounts/${accountId}/timeentries/latest`,
    { query: { userId } },
  );
  return latest ?? undefined;
}

export function registerTimerTools(server: McpServer, deps: ToolDeps): void {
  defineTool(server, deps, {
    name: "tmetric_get_active_timer",
    title: "Check the running TMetric timer",
    description: `Report whether a timer is currently running, and on what.

Worth checking before filling in a day: an open timer occupies the end of that day, so appended entries would collide with it.

Args:
  - account_id (number): workspace id (default: your active workspace)
  - user_id (number): whose timer to check (default: yourself)
  - response_format ('markdown' | 'json')

Returns:
  {
    "is_running": boolean,
    "message": string,
    "entry": { "id": number, "date": string, "start_time": string, "end_time": null,
               "duration_minutes": number, "duration_human": string, "is_running": boolean,
               "note": string, "task": string,
               "project": { "id": number, "name": string, "client": string } }
  }

Examples:
  - Use when: "am I still tracking anything?" -> {}
  - Use when: a create call failed because a timer is running -> {}
  - Don't use when: you want the whole day (use tmetric_list_time_entries)`,
    inputSchema: activeInput,
    outputSchema: activeOutput,
    annotations: READ_ONLY,
    handler: async (args, toolDeps) => {
      const { accountId, userId } = await toolDeps.context.resolve(args.account_id, args.user_id);
      const latest = await fetchLatest(toolDeps, accountId, userId);

      const entry = latest ? mapTimeEntry(latest) : undefined;
      const isRunning = entry?.is_running ?? false;

      const output = {
        is_running: isRunning,
        ...(entry ? { entry } : {}),
        message: isRunning
          ? `A timer has been running since ${entry?.start_time} on ${entry?.date} (${entry?.duration_human} so far).`
          : entry
            ? `No timer is running. The last entry ended at ${entry.end_time} on ${entry.date}.`
            : "No timer is running and no time entries were found.",
      };

      return buildToolResult(
        output,
        (value) => (value.entry ? `${value.message}\n\n${renderTimeEntryLine(value.entry)}` : value.message),
        args.response_format as ResponseFormat,
      );
    },
  });

  defineTool(server, deps, {
    name: "tmetric_start_timer",
    title: "Start a TMetric timer",
    description: `Start tracking time from this moment, leaving the entry open until it is stopped.

TMetric closes any timer that is already running when a new one starts. For work that has already happened, use tmetric_create_time_entry instead — it lets you state the day and the duration directly.

Args:
  - note (string): what you are working on
  - project_id (number): project to book to, from tmetric_list_projects
  - task_id (number) | task_name (string): task to link
  - tag_ids (number[]) | tag_names (string[]): tags or work types
  - is_billable (boolean)
  - account_id (number), user_id (number)
  - response_format ('markdown' | 'json')

Returns:
  {
    "started": boolean,
    "started_at": string,               // local timestamp, e.g. "2026-08-25T14:03:00"
    "message": string,
    "entry": { ...the running time entry... }
  }

Examples:
  - Use when: "start tracking my work on the invoice bug" -> {"note": "Invoice bug", "project_id": 500001}
  - Don't use when: logging work that is already finished (use tmetric_create_time_entry)

Error handling:
  - Reports a 400 when the workspace requires a project, task or description that was not supplied.`,
    inputSchema: startInput,
    outputSchema: startOutput,
    annotations: CREATES,
    handler: async (args, toolDeps) => {
      const { accountId, userId } = await toolDeps.context.resolve(args.account_id, args.user_id);
      const startTime = nowLocalTimestamp();

      const tags = [
        ...(args.tag_ids ?? []).map((id) => ({ id })),
        ...(args.tag_names ?? []).map((name) => ({ name })),
      ];
      const task =
        args.task_id !== undefined || args.task_name !== undefined
          ? {
              ...(args.task_id !== undefined ? { id: args.task_id } : {}),
              ...(args.task_name !== undefined ? { name: args.task_name } : {}),
            }
          : undefined;

      const payload: TMetricTimeEntry = {
        startTime,
        endTime: null,
        ...(args.note !== undefined ? { note: args.note } : {}),
        ...(args.project_id !== undefined ? { project: { id: args.project_id } } : {}),
        ...(task ? { task } : {}),
        ...(tags.length ? { tags } : {}),
        ...(args.is_billable !== undefined ? { isBillable: args.is_billable } : {}),
      };

      const affected = await toolDeps.client.request<TMetricTimeEntry[]>(`/accounts/${accountId}/timeentries`, {
        method: "POST",
        query: { userId },
        body: payload,
      });

      const created = (affected ?? []).find((item) => normalizeApiDateTime(item.startTime) === startTime);
      const entry = created ? mapTimeEntry(created) : undefined;

      const output = {
        started: true,
        started_at: startTime,
        ...(entry ? { entry } : {}),
        message: `Timer started at ${startTime.slice(11, 16)}${args.note ? ` on "${args.note}"` : ""}.`,
      };

      return buildToolResult(
        output,
        (value) => (value.entry ? `${value.message}\n\n${renderTimeEntryLine(value.entry)}` : value.message),
        args.response_format as ResponseFormat,
      );
    },
  });

  defineTool(server, deps, {
    name: "tmetric_stop_timer",
    title: "Stop the running TMetric timer",
    description: `Close the currently running timer at this moment.

Returns the finished entry with its total duration. When nothing is running the call succeeds with "stopped": false rather than failing, so it is safe to call defensively before filling in a day.

Args:
  - account_id (number): workspace id (default: your active workspace)
  - user_id (number): whose timer to stop (default: yourself)
  - response_format ('markdown' | 'json')

Returns:
  {
    "stopped": boolean,                 // false when nothing was running
    "message": string,
    "entry": { "id": number, "date": string, "start_time": string, "end_time": string,
               "duration_minutes": number, "duration_human": string, "is_running": false,
               "note": string, "project": { "id": number, "name": string } }
  }

Examples:
  - Use when: "stop the timer" -> {}
  - Use when: an append failed because a timer is open on that day -> {}

Error handling:
  - Returns a 403 when manual editing is disabled and the entry cannot be closed through the API.`,
    inputSchema: stopInput,
    outputSchema: stopOutput,
    annotations: UPDATES,
    handler: async (args, toolDeps) => {
      const { accountId, userId } = await toolDeps.context.resolve(args.account_id, args.user_id);
      const latest = await fetchLatest(toolDeps, accountId, userId);

      if (!latest || latest.endTime || latest.id === undefined) {
        const output = {
          stopped: false,
          ...(latest ? { entry: mapTimeEntry(latest) } : {}),
          message: latest ? "No timer is running; the latest entry is already closed." : "No timer is running.",
        };
        return buildToolResult(output, (value) => value.message, args.response_format as ResponseFormat);
      }

      const startTime = normalizeApiDateTime(latest.startTime);
      if (!startTime) {
        throw new TMetricApiError(
          `The running entry ${latest.id} has no start time and cannot be closed through the API.`,
          undefined,
          "stop_timer",
        );
      }

      const endTime = nowLocalTimestamp();
      const updated = await toolDeps.client.request<TMetricTimeEntry>(
        `/accounts/${accountId}/timeentries/${latest.id}`,
        {
          method: "PUT",
          body: {
            startTime,
            endTime,
            note: latest.note,
            ...(latest.project ? { project: latest.project } : {}),
            ...(latest.task ? { task: latest.task } : {}),
            ...(latest.tags?.length ? { tags: latest.tags } : {}),
            ...(latest.isBillable !== undefined ? { isBillable: latest.isBillable } : {}),
          },
        },
      );

      const entry = mapTimeEntry(updated ?? { ...latest, endTime });
      const output = {
        stopped: true,
        entry,
        message: `Timer stopped. Logged ${formatDuration(entry.duration_minutes)} on ${entry.date} (${entry.start_time}–${entry.end_time})${entry.note ? ` for "${escapeCell(entry.note)}"` : ""}.`,
      };

      return buildToolResult(
        output,
        (value) => `${value.message}\n\n${renderTimeEntryLine(value.entry)}`,
        args.response_format as ResponseFormat,
      );
    },
  });
}
