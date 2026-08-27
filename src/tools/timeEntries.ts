/**
 * Time entry tools — the core of this server.
 *
 * They cover the full retroactive-logging loop: see what a day already contains,
 * append work to it (one entry or a whole day at once), correct an entry, and
 * remove one. Durations are placed automatically so the caller can think in
 * "three hours on X" rather than in clock times.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_BULK_ENTRIES } from "../constants.js";
import {
  accountIdSchema,
  clockTimeSchema,
  dateSchema,
  limitSchema,
  offsetSchema,
  pageMetaShape,
  responseFormatSchema,
  timeEntrySchema,
  userIdSchema,
  type TimeEntryOutput,
} from "../schemas/common.js";
import { TMetricApiError, type TMetricClient } from "../services/client.js";
import {
  describeSpan,
  fetchDayEntries,
  findOverlap,
  findRunningSpan,
  nextFreeMinute,
  throwOverlapError,
  toOccupiedSpans,
} from "../services/dayPlanner.js";
import type { TMetricRecentTimeEntry, TMetricTimeEntry } from "../types.js";
import {
  addDays,
  dateOf,
  formatDuration,
  localDateTime,
  minutesBetween,
  normalizeApiDateTime,
  resolveDate,
  timeOf,
  timeToMinutes,
  toDecimalHours,
} from "../utils/datetime.js";
import {
  buildToolResult,
  escapeCell,
  halveList,
  joinParts,
  paginate,
  type PageMeta,
  type ResponseFormat,
} from "../utils/format.js";
import { mapTimeEntry, mapProject, mapTag, renderTimeEntryLine } from "../utils/mappers.js";
import { CREATES, DELETES, defineTool, READ_ONLY, UPDATES, type ToolDeps } from "./registry.js";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** Weekday name of a `YYYY-MM-DD` date, computed without timezone drift. */
function weekdayOf(date: string): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] as string;
}

/* ------------------------------------------------------ shared entry input ---- */

const entrySpecShape = {
  date: dateSchema.describe("Day the work happened on, as YYYY-MM-DD or 'today' / 'yesterday'."),
  duration_hours: z
    .number()
    .positive()
    .max(24)
    .optional()
    .describe("Length of the work in hours, e.g. 1.5. Use this or duration_minutes or end_time."),
  duration_minutes: z
    .number()
    .int()
    .positive()
    .max(1440)
    .optional()
    .describe("Length of the work in whole minutes. Use this or duration_hours or end_time."),
  start_time: clockTimeSchema
    .optional()
    .describe(
      "Local start time as HH:mm. Omit to append the entry right after the last one already logged that day.",
    ),
  end_time: clockTimeSchema
    .optional()
    .describe("Local end time as HH:mm. Requires start_time. An earlier value than start_time means the entry crosses midnight."),
  note: z.string().max(2000).optional().describe("What you worked on. Free text shown as the entry description."),
  project_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Project to book the time to. Look ids up with tmetric_list_projects."),
  task_id: z.number().int().positive().optional().describe("Existing task to link, from tmetric_list_tasks."),
  task_name: z
    .string()
    .max(400)
    .optional()
    .describe("Name of a task to link; TMetric creates it in the project when it does not exist and the workspace allows new tasks."),
  tag_ids: z.array(z.number().int().positive()).max(20).optional().describe("Tag ids from tmetric_list_tags."),
  tag_names: z
    .array(z.string().min(1).max(100))
    .max(20)
    .optional()
    .describe("Tag names; existing tags are matched by name, new ones are created when the workspace allows it."),
  is_billable: z.boolean().optional().describe("Mark the time as billable. Only meaningful on a billable project."),
} as const;

const entrySpecSchema = z.object(entrySpecShape).strict();
type EntrySpec = z.infer<typeof entrySpecSchema>;

/** Resolves a spec's length in minutes, rejecting ambiguous combinations. */
function resolveDurationMinutes(spec: EntrySpec, startMinutes: number): number {
  const hasDuration = spec.duration_hours !== undefined || spec.duration_minutes !== undefined;

  if (spec.duration_hours !== undefined && spec.duration_minutes !== undefined) {
    throw new TMetricApiError(
      `Entry for ${spec.date} sets both duration_hours and duration_minutes. Provide exactly one of them.`,
      undefined,
      "create_time_entry",
    );
  }

  if (spec.end_time !== undefined) {
    if (hasDuration) {
      throw new TMetricApiError(
        `Entry for ${spec.date} sets end_time together with a duration. Provide either end_time or a duration, not both.`,
        undefined,
        "create_time_entry",
      );
    }
    if (spec.start_time === undefined) {
      throw new TMetricApiError(
        `Entry for ${spec.date} sets end_time without start_time. Add start_time, or replace both with duration_hours / duration_minutes.`,
        undefined,
        "create_time_entry",
      );
    }
    const endMinutes = timeToMinutes(spec.end_time, "end_time");
    // An end at or before the start means the work ran past midnight.
    const span = endMinutes > startMinutes ? endMinutes - startMinutes : endMinutes + 24 * 60 - startMinutes;
    if (span <= 0) {
      throw new TMetricApiError(
        `Entry for ${spec.date} has a zero-length span between start_time and end_time.`,
        undefined,
        "create_time_entry",
      );
    }
    return span;
  }

  if (!hasDuration) {
    throw new TMetricApiError(
      `Entry for ${spec.date} has no length. Provide duration_hours, duration_minutes, or start_time together with end_time.`,
      undefined,
      "create_time_entry",
    );
  }

  const minutes =
    spec.duration_minutes !== undefined ? spec.duration_minutes : Math.round((spec.duration_hours as number) * 60);
  if (minutes <= 0) {
    throw new TMetricApiError(`Entry for ${spec.date} has a non-positive duration.`, undefined, "create_time_entry");
  }
  return minutes;
}

/** Builds the API payload for one entry from a spec and its resolved span. */
function buildEntryPayload(spec: EntrySpec, startTime: string, endTime: string | null): TMetricTimeEntry {
  const tags = [
    ...(spec.tag_ids ?? []).map((id) => ({ id })),
    ...(spec.tag_names ?? []).map((name) => ({ name })),
  ];

  const task =
    spec.task_id !== undefined || spec.task_name !== undefined
      ? {
          ...(spec.task_id !== undefined ? { id: spec.task_id } : {}),
          ...(spec.task_name !== undefined ? { name: spec.task_name } : {}),
        }
      : undefined;

  return {
    startTime,
    endTime,
    ...(spec.note !== undefined ? { note: spec.note } : {}),
    ...(spec.project_id !== undefined ? { project: { id: spec.project_id } } : {}),
    ...(task ? { task } : {}),
    ...(tags.length ? { tags } : {}),
    ...(spec.is_billable !== undefined ? { isBillable: spec.is_billable } : {}),
  };
}

interface PlacementOptions {
  allowOverlap: boolean;
  dayStartMinutes: number;
  dryRun: boolean;
}

interface PlacementResult {
  index: number;
  date: string;
  start_time: string;
  end_time: string;
  duration_minutes: number;
  duration_human: string;
  status: "created" | "planned" | "failed";
  entry?: TimeEntryOutput;
  error?: string;
}

/**
 * Places and creates a batch of entries.
 *
 * Entries are grouped by day so each day is read once; within a day they are laid
 * end to end starting after whatever is already logged. Failures are reported per
 * entry instead of aborting the batch, because a partially filled day is still
 * useful and the caller needs to know exactly what landed.
 */
async function placeAndCreate(
  client: TMetricClient,
  accountId: number,
  userId: number,
  specs: EntrySpec[],
  options: PlacementOptions,
): Promise<PlacementResult[]> {
  const resolved = specs.map((spec, index) => ({ index, spec, date: resolveDate(spec.date) }));

  const byDate = new Map<string, Array<{ index: number; spec: EntrySpec }>>();
  for (const item of resolved) {
    const bucket = byDate.get(item.date);
    if (bucket) bucket.push(item);
    else byDate.set(item.date, [{ index: item.index, spec: item.spec }]);
  }

  const results: PlacementResult[] = [];

  for (const [date, items] of byDate) {
    const spans = toOccupiedSpans(await fetchDayEntries(client, accountId, userId, date), date);
    let cursor = nextFreeMinute(spans, options.dayStartMinutes);

    for (const { index, spec } of items) {
      try {
        const explicitStart = spec.start_time !== undefined;
        if (!explicitStart) {
          const running = findRunningSpan(spans);
          if (running) {
            throw new TMetricApiError(
              `A timer is still running on ${date} (${describeSpan(running, date)}), so there is no free slot to append to. Stop it with tmetric_stop_timer, or pass an explicit start_time.`,
              undefined,
              "create_time_entry",
            );
          }
        }

        const startMinutes = explicitStart ? timeToMinutes(spec.start_time as string, "start_time") : cursor;
        const durationMinutes = resolveDurationMinutes(spec, startMinutes);
        const endMinutes = startMinutes + durationMinutes;

        if (!options.allowOverlap) {
          const conflict = findOverlap(spans, startMinutes, endMinutes);
          if (conflict) throwOverlapError(conflict, date, "create_time_entry");
        }

        const startTime = localDateTime(date, startMinutes);
        const endTime = localDateTime(date, endMinutes);
        const payload = buildEntryPayload(spec, startTime, endTime);

        let created: TimeEntryOutput | undefined;
        if (!options.dryRun) {
          const affected = await client.request<TMetricTimeEntry[]>(`/accounts/${accountId}/timeentries`, {
            method: "POST",
            query: { userId },
            body: payload,
          });
          const match = (affected ?? []).find(
            (entry) => normalizeApiDateTime(entry.startTime) === startTime,
          );
          created = match ? mapTimeEntry(match) : undefined;
        }

        spans.push({
          id: created?.id,
          label: spec.task_name ?? spec.note ?? "(no description)",
          startMinutes,
          endMinutes,
        });
        spans.sort((a, b) => a.startMinutes - b.startMinutes);
        cursor = Math.max(cursor, endMinutes);

        results.push({
          index,
          date,
          start_time: timeOf(startTime),
          end_time: timeOf(endTime),
          duration_minutes: durationMinutes,
          duration_human: formatDuration(durationMinutes),
          status: options.dryRun ? "planned" : "created",
          ...(created ? { entry: created } : {}),
        });
      } catch (error) {
        results.push({
          index,
          date,
          start_time: "",
          end_time: "",
          duration_minutes: 0,
          duration_human: "0m",
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return results.sort((a, b) => a.index - b.index);
}

/* -------------------------------------------------------------- list entries -- */

const listInput = z
  .object({
    start_date: dateSchema.describe("First day to include (YYYY-MM-DD, or 'today' / 'yesterday')."),
    end_date: dateSchema.optional().describe("Last day to include, inclusive. Defaults to start_date."),
    account_id: accountIdSchema,
    user_id: userIdSchema,
    limit: limitSchema,
    offset: offsetSchema,
    response_format: responseFormatSchema,
  })
  .strict();

const daySchema = z.object({
  date: z.string(),
  weekday: z.string(),
  entry_count: z.number().int(),
  total_minutes: z.number(),
  total_hours: z.number(),
  total_human: z.string(),
  entries: z.array(timeEntrySchema),
});

const listOutput = {
  ...pageMetaShape,
  start_date: z.string(),
  end_date: z.string(),
  account_id: z.number().int(),
  user_id: z.number().int(),
  total_minutes: z.number().describe("Sum over the entries in this page."),
  total_hours: z.number(),
  total_human: z.string(),
  days_with_time: z.number().int().describe("How many days in the page contain at least one entry."),
  days: z.array(daySchema).describe("Entries grouped by calendar day, oldest first."),
} as const;

type ListOutput = PageMeta & {
  start_date: string;
  end_date: string;
  account_id: number;
  user_id: number;
  total_minutes: number;
  total_hours: number;
  total_human: string;
  days_with_time: number;
  days: Array<z.infer<typeof daySchema>>;
};

/** Groups a flat, chronologically sorted page of entries into day buckets. */
function groupByDay(entries: TimeEntryOutput[]): Array<z.infer<typeof daySchema>> {
  const buckets = new Map<string, TimeEntryOutput[]>();
  for (const entry of entries) {
    const bucket = buckets.get(entry.date);
    if (bucket) bucket.push(entry);
    else buckets.set(entry.date, [entry]);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dayEntries]) => {
      const totalMinutes = dayEntries.reduce((sum, entry) => sum + entry.duration_minutes, 0);
      return {
        date,
        weekday: weekdayOf(date),
        entry_count: dayEntries.length,
        total_minutes: totalMinutes,
        total_hours: toDecimalHours(totalMinutes),
        total_human: formatDuration(totalMinutes),
        entries: dayEntries,
      };
    });
}

function renderList(output: ListOutput): string {
  const range = output.start_date === output.end_date ? output.start_date : `${output.start_date} → ${output.end_date}`;
  const entryWord = output.total === 1 ? "entry" : "entries";
  const dayWord = output.days_with_time === 1 ? "day" : "days";
  const lines = [
    `# Time entries ${range}`,
    "",
    `**${output.total_human}** across ${output.total} ${entryWord} on ${output.days_with_time} ${dayWord}.`,
    "",
  ];

  if (output.days.length === 0) {
    lines.push("No time is logged in this range.");
    return lines.join("\n");
  }

  for (const day of output.days) {
    lines.push(`## ${day.date} (${day.weekday}) — ${day.total_human}`, "");
    for (const entry of day.entries) lines.push(renderTimeEntryLine(entry));
    lines.push("");
  }

  if (output.has_more) lines.push(`More entries available — call again with offset=${output.next_offset}.`);
  if (output.truncation_message) lines.push(output.truncation_message);
  return lines.join("\n");
}

/**
 * Shrinker that drops the last day of the range at a time.
 *
 * Dropping one day per step rather than halving keeps as much of the range as
 * actually fits; the caller is told where the data stops so it can ask for the
 * remainder.
 */
function dropLastDay(output: ListOutput): ListOutput | null {
  if (output.days.length <= 1) return null;
  const kept = output.days.slice(0, output.days.length - 1);
  const lastKept = kept[kept.length - 1] as (typeof kept)[number];
  return {
    ...output,
    days: kept,
    count: kept.reduce((sum, day) => sum + day.entry_count, 0),
    days_with_time: kept.length,
    truncated: true,
    truncation_message: `Response was too large, so it stops after ${lastKept.date}. Request the remaining days with start_date=${addDays(lastKept.date, 1)} and the same end_date, or switch to response_format='markdown', which is far more compact.`,
  };
}

/* ------------------------------------------------------------ recent entries -- */

const recentInput = z
  .object({
    account_id: accountIdSchema,
    user_id: userIdSchema,
    limit: limitSchema,
    offset: offsetSchema,
    response_format: responseFormatSchema,
  })
  .strict();

const recentItemSchema = z.object({
  note: z.string().optional(),
  task: z.string().optional(),
  task_id: z.number().int().optional(),
  project: z.object({ id: z.number().int().optional(), name: z.string().optional(), client: z.string().optional(), is_billable: z.boolean().optional() }).optional(),
  tags: z.array(z.object({ id: z.number().int().optional(), name: z.string().optional(), is_work_type: z.boolean().optional() })).optional(),
  is_billable: z.boolean().optional(),
  is_pinned: z.boolean().optional(),
});

const recentOutput = {
  ...pageMetaShape,
  recent_entries: z.array(recentItemSchema),
} as const;

type RecentOutput = PageMeta & { recent_entries: Array<z.infer<typeof recentItemSchema>> };

function renderRecent(output: RecentOutput): string {
  if (output.recent_entries.length === 0) return "No recent time entries to reuse.";
  const lines = [`# Recent work (${output.count} of ${output.total})`, ""];
  for (const item of output.recent_entries) {
    const label = item.task ?? item.note ?? "(no description)";
    const meta = joinParts([
      item.project?.name ? `project_id: ${item.project.id} (${item.project.name})` : undefined,
      item.task_id !== undefined ? `task_id: ${item.task_id}` : undefined,
      item.tags?.length ? `tags: ${item.tags.map((tag) => tag.name).join(", ")}` : undefined,
      item.is_pinned ? "pinned" : undefined,
    ]);
    lines.push(`- ${escapeCell(label)}${meta ? `\n  ${meta}` : ""}`);
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ mutations -- */

const createInput = z
  .object({
    ...entrySpecShape,
    allow_overlap: z
      .boolean()
      .default(false)
      .describe("Permit the entry to overlap existing time. When false (default) an overlap is refused with details of the conflict."),
    day_start_time: clockTimeSchema
      .default("09:00")
      .describe("Where to begin when start_time is omitted and the day has no entries yet."),
    dry_run: z.boolean().default(false).describe("Compute and return the slot without writing anything to TMetric."),
    account_id: accountIdSchema,
    user_id: userIdSchema,
    response_format: responseFormatSchema,
  })
  .strict();

const bulkInput = z
  .object({
    entries: z
      .array(entrySpecSchema)
      .min(1)
      .max(MAX_BULK_ENTRIES)
      .describe(
        `Entries to create, in the order they should appear in the day. 1-${MAX_BULK_ENTRIES} items; entries for the same date are laid end to end.`,
      ),
    allow_overlap: z.boolean().default(false).describe("Permit entries to overlap existing time."),
    day_start_time: clockTimeSchema
      .default("09:00")
      .describe("Where a day's first appended entry begins when the day is empty and start_time is omitted."),
    dry_run: z
      .boolean()
      .default(false)
      .describe("Return the planned slots without writing anything. Use this to preview a whole day before committing."),
    account_id: accountIdSchema,
    user_id: userIdSchema,
    response_format: responseFormatSchema,
  })
  .strict();

const placementResultSchema = z.object({
  index: z.number().int().describe("Position of this entry in the request."),
  date: z.string(),
  start_time: z.string(),
  end_time: z.string(),
  duration_minutes: z.number(),
  duration_human: z.string(),
  status: z.enum(["created", "planned", "failed"]),
  entry: timeEntrySchema.optional().describe("The entry as TMetric stored it; absent on dry runs and failures."),
  error: z.string().optional().describe("Why this entry could not be created."),
});

const createOutput = {
  created: z.boolean().describe("True when the entry was written to TMetric."),
  dry_run: z.boolean(),
  result: placementResultSchema,
  day_total_human: z.string().describe("Total time logged on that day after this call."),
} as const;

const bulkOutput = {
  dry_run: z.boolean(),
  requested: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  results: z.array(placementResultSchema),
  day_totals: z
    .array(z.object({ date: z.string(), weekday: z.string(), total_human: z.string(), total_hours: z.number() }))
    .describe("Time logged per affected day after this call."),
} as const;

const updateInput = z
  .object({
    time_entry_id: z.number().int().positive().describe("Id of the entry to change, from tmetric_list_time_entries."),
    date: dateSchema.describe("The day the entry currently sits on. Required so the entry can be read and merged rather than overwritten blindly."),
    new_date: dateSchema.optional().describe("Move the entry to another day."),
    start_time: clockTimeSchema.optional().describe("New local start time as HH:mm."),
    end_time: clockTimeSchema.optional().describe("New local end time as HH:mm."),
    duration_hours: z.number().positive().max(24).optional().describe("New length in hours, keeping the existing start time."),
    duration_minutes: z.number().int().positive().max(1440).optional().describe("New length in whole minutes, keeping the existing start time."),
    note: z.string().max(2000).optional().describe("Replacement description."),
    project_id: z.number().int().positive().optional().describe("Move the entry to another project."),
    task_id: z.number().int().positive().optional(),
    task_name: z.string().max(400).optional(),
    tag_ids: z.array(z.number().int().positive()).max(20).optional().describe("Replaces the entry's tags."),
    tag_names: z.array(z.string().min(1).max(100)).max(20).optional().describe("Replaces the entry's tags."),
    is_billable: z.boolean().optional(),
    account_id: accountIdSchema,
    user_id: userIdSchema,
    response_format: responseFormatSchema,
  })
  .strict();

const updateOutput = {
  updated: z.boolean(),
  entry: timeEntrySchema.describe("The entry after the change."),
  changed_fields: z.array(z.string()).describe("Names of the fields this call modified."),
} as const;

const deleteInput = z
  .object({
    time_entry_id: z.number().int().positive().describe("Id of the entry to delete, from tmetric_list_time_entries."),
    account_id: accountIdSchema,
    response_format: responseFormatSchema,
  })
  .strict();

const deleteOutput = {
  deleted: z.boolean(),
  time_entry_id: z.number().int(),
  message: z.string(),
} as const;

/** Fetches one entry by id from the day it lives on. */
async function findEntryOnDay(
  client: TMetricClient,
  accountId: number,
  userId: number,
  date: string,
  timeEntryId: number,
): Promise<TMetricTimeEntry> {
  const entries = await fetchDayEntries(client, accountId, userId, date);
  const found = entries.find((entry) => entry.id === timeEntryId);
  if (!found) {
    const available = entries
      .map((entry) => `${entry.id} (${timeOf(normalizeApiDateTime(entry.startTime) ?? "")})`)
      .join(", ");
    throw new TMetricApiError(
      `No time entry with id ${timeEntryId} exists on ${date}. Entries on that day: ${available || "none"}. Pass the date the entry actually sits on, or list the range with tmetric_list_time_entries.`,
      404,
      `/accounts/${accountId}/timeentries`,
    );
  }
  return found;
}

/* --------------------------------------------------------------- registration -- */

export function registerTimeEntryTools(server: McpServer, deps: ToolDeps): void {
  defineTool(server, deps, {
    name: "tmetric_list_time_entries",
    title: "List TMetric time entries for a date range",
    description: `Return the time entries logged in a date range, grouped by day with per-day totals.

This is how you check what is already recorded before filling gaps: each day shows its entries with start and end times, durations, project, task, tags and the entry id needed to update or delete it.

Args:
  - start_date (string): first day, YYYY-MM-DD or 'today' / 'yesterday' (required)
  - end_date (string): last day, inclusive (default: same as start_date)
  - account_id (number): workspace id (default: your active workspace)
  - user_id (number): whose timeline to read (default: yourself; other users need team-view permission)
  - limit (number): maximum entries in the page, 1-500 (default: 50)
  - offset (number): entries to skip (default: 0)
  - response_format ('markdown' | 'json')

Returns:
  {
    "start_date": string, "end_date": string,
    "account_id": number, "user_id": number,
    "total": number,                    // entries in the range
    "count": number, "offset": number, "has_more": boolean, "next_offset": number,
    "total_minutes": number, "total_hours": number, "total_human": string,
    "days_with_time": number,
    "days": [
      {
        "date": string, "weekday": string, "entry_count": number,
        "total_minutes": number, "total_hours": number, "total_human": string,
        "entries": [
          { "id": number, "date": string, "start_time": string, "end_time": string,
            "duration_minutes": number, "duration_hours": number, "duration_human": string,
            "is_running": boolean, "note": string, "task": string, "task_id": number,
            "project": { "id": number, "name": string, "client": string, "is_billable": boolean },
            "tags": [ { "id": number, "name": string, "is_work_type": boolean } ],
            "is_billable": boolean, "is_invoiced": boolean, "external_link": string }
        ]
      }
    ]
  }

Examples:
  - Use when: "what did I log last week" -> {"start_date": "2026-08-17", "end_date": "2026-08-21"}
  - Use when: checking a single day before adding to it -> {"start_date": "2026-08-20"}
  - Use when: you need an entry id to correct it -> {"start_date": "2026-08-20", "response_format": "json"}
  - Don't use when: you want per-project totals rather than individual entries (use tmetric_get_time_summary)

Error handling:
  - Returns a permission error when reading another user's timeline without team-view rights.
  - A range wider than the size limit is truncated to whole days, with a message saying so.`,
    inputSchema: listInput,
    outputSchema: listOutput,
    annotations: READ_ONLY,
    handler: async (args, { client, context }) => {
      const { accountId, userId } = await context.resolve(args.account_id, args.user_id);
      const startDate = resolveDate(args.start_date, "start_date");
      const endDate = args.end_date ? resolveDate(args.end_date, "end_date") : startDate;

      if (endDate < startDate) {
        throw new TMetricApiError(
          `end_date (${endDate}) is before start_date (${startDate}). Swap them or omit end_date for a single day.`,
          undefined,
          "list_time_entries",
        );
      }

      const raw = await client.request<TMetricTimeEntry[]>(`/accounts/${accountId}/timeentries`, {
        query: { userId, startDate, endDate },
      });

      const entries = (raw ?? [])
        .map(mapTimeEntry)
        .filter((entry) => entry.date >= startDate && entry.date <= endDate)
        .sort((a, b) => a.date.localeCompare(b.date) || (a.start_time ?? "").localeCompare(b.start_time ?? ""));

      const { page, meta } = paginate(entries, args.limit, args.offset);
      const days = groupByDay(page);
      const totalMinutes = page.reduce((sum, entry) => sum + entry.duration_minutes, 0);

      const output: ListOutput = {
        ...meta,
        start_date: startDate,
        end_date: endDate,
        account_id: accountId,
        user_id: userId,
        total_minutes: totalMinutes,
        total_hours: toDecimalHours(totalMinutes),
        total_human: formatDuration(totalMinutes),
        days_with_time: days.length,
        days,
      };

      return buildToolResult(output, renderList, args.response_format as ResponseFormat, dropLastDay);
    },
  });

  defineTool(server, deps, {
    name: "tmetric_create_time_entry",
    title: "Log one TMetric time entry",
    description: `Log a single block of work on a given day.

Give a date and a length; the entry is placed automatically after whatever is already logged that day, so you do not have to invent clock times. Pass start_time when the exact time matters. Overlaps with existing entries are refused by default and reported with the conflicting entry, which keeps an unattended agent from corrupting a timesheet.

Args:
  - date (string): day the work happened, YYYY-MM-DD or 'today' / 'yesterday' (required)
  - duration_hours (number) | duration_minutes (number) | end_time (string): the length; exactly one form
  - start_time (string): local HH:mm start; omit to append after the last entry of that day
  - end_time (string): local HH:mm end; requires start_time
  - note (string): what you worked on
  - project_id (number): project to book to, from tmetric_list_projects
  - task_id (number) | task_name (string): task to link; a new name is created when the workspace allows it
  - tag_ids (number[]) | tag_names (string[]): tags or work types
  - is_billable (boolean)
  - allow_overlap (boolean): permit overlapping existing time (default: false)
  - day_start_time (string): where an empty day starts when start_time is omitted (default: '09:00')
  - dry_run (boolean): compute the slot without writing (default: false)
  - account_id (number), user_id (number)
  - response_format ('markdown' | 'json')

Returns:
  {
    "created": boolean, "dry_run": boolean,
    "day_total_human": string,          // total logged on that day afterwards
    "result": {
      "index": number, "date": string, "start_time": string, "end_time": string,
      "duration_minutes": number, "duration_human": string,
      "status": "created" | "planned" | "failed",
      "entry": { ...time entry as stored... },
      "error": string
    }
  }

Examples:
  - Use when: "I spent 3 hours on the API migration yesterday" -> {"date": "yesterday", "duration_hours": 3, "note": "API migration", "project_id": 500001}
  - Use when: the exact window matters -> {"date": "2026-08-20", "start_time": "14:00", "end_time": "16:30", "note": "Client call"}
  - Use when: previewing before writing -> {"date": "2026-08-20", "duration_hours": 2, "dry_run": true}
  - Don't use when: filling a whole day at once (use tmetric_create_time_entries_bulk, which reads the day only once)

Error handling:
  - Refuses with the conflicting entry's span and id when the slot overlaps, unless allow_overlap is true.
  - Refuses to append when a timer is still running that day; stop it with tmetric_stop_timer first.
  - Reports a 400 from TMetric when the workspace requires a project, task, description or tag that was not supplied — check the rules with tmetric_get_current_user.`,
    inputSchema: createInput,
    outputSchema: createOutput,
    annotations: CREATES,
    handler: async (args, { client, context }) => {
      const { accountId, userId } = await context.resolve(args.account_id, args.user_id);
      const spec = entrySpecSchema.parse({
        date: args.date,
        ...(args.duration_hours !== undefined ? { duration_hours: args.duration_hours } : {}),
        ...(args.duration_minutes !== undefined ? { duration_minutes: args.duration_minutes } : {}),
        ...(args.start_time !== undefined ? { start_time: args.start_time } : {}),
        ...(args.end_time !== undefined ? { end_time: args.end_time } : {}),
        ...(args.note !== undefined ? { note: args.note } : {}),
        ...(args.project_id !== undefined ? { project_id: args.project_id } : {}),
        ...(args.task_id !== undefined ? { task_id: args.task_id } : {}),
        ...(args.task_name !== undefined ? { task_name: args.task_name } : {}),
        ...(args.tag_ids !== undefined ? { tag_ids: args.tag_ids } : {}),
        ...(args.tag_names !== undefined ? { tag_names: args.tag_names } : {}),
        ...(args.is_billable !== undefined ? { is_billable: args.is_billable } : {}),
      });

      const [result] = await placeAndCreate(client, accountId, userId, [spec], {
        allowOverlap: args.allow_overlap,
        dayStartMinutes: timeToMinutes(args.day_start_time, "day_start_time"),
        dryRun: args.dry_run,
      });

      if (!result) {
        throw new TMetricApiError("The entry could not be placed.", undefined, "create_time_entry");
      }
      if (result.status === "failed") {
        throw new TMetricApiError(result.error ?? "The entry could not be created.", undefined, "create_time_entry");
      }

      const daySpans = toOccupiedSpans(await fetchDayEntries(client, accountId, userId, result.date), result.date);
      const dayMinutes = daySpans.reduce(
        (sum, span) => (span.endMinutes === null ? sum : sum + (span.endMinutes - span.startMinutes)),
        0,
      );

      const output = {
        created: result.status === "created",
        dry_run: args.dry_run,
        result,
        day_total_human: formatDuration(dayMinutes),
      };

      return buildToolResult(
        output,
        (value) => {
          const verb = value.dry_run ? "Would log" : "Logged";
          const label = value.result.entry?.task ?? value.result.entry?.note ?? args.note ?? "(no description)";
          const project = value.result.entry?.project?.name;
          return [
            `${verb} **${value.result.duration_human}** on ${value.result.date} (${weekdayOf(value.result.date)}), ${value.result.start_time}–${value.result.end_time}.`,
            "",
            `- Description: ${escapeCell(label)}`,
            project ? `- Project: ${escapeCell(project)}` : undefined,
            value.result.entry?.id !== undefined ? `- Entry id: ${value.result.entry.id}` : undefined,
            `- Day total after this call: ${value.day_total_human}`,
          ]
            .filter(Boolean)
            .join("\n");
        },
        args.response_format as ResponseFormat,
      );
    },
  });

  defineTool(server, deps, {
    name: "tmetric_create_time_entries_bulk",
    title: "Log several TMetric time entries at once",
    description: `Log many blocks of work in one call, filling one or more days.

Entries for the same date are laid end to end in the order given, starting after whatever that day already contains, so a whole day can be reconstructed from a list of "what I did and for how long". Each day is read once, which is both faster and less likely to hit rate limits than repeated single calls. Failures are reported per entry and do not abort the rest of the batch.

Args:
  - entries (array, 1-${MAX_BULK_ENTRIES}, required): each item accepts the same fields as tmetric_create_time_entry —
      date, duration_hours | duration_minutes | (start_time + end_time), note,
      project_id, task_id | task_name, tag_ids | tag_names, is_billable
  - allow_overlap (boolean): permit overlaps with existing time (default: false)
  - day_start_time (string): where an empty day starts (default: '09:00')
  - dry_run (boolean): return the planned layout without writing (default: false)
  - account_id (number), user_id (number)
  - response_format ('markdown' | 'json')

Returns:
  {
    "dry_run": boolean,
    "requested": number, "succeeded": number, "failed": number,
    "results": [
      { "index": number, "date": string, "start_time": string, "end_time": string,
        "duration_minutes": number, "duration_human": string,
        "status": "created" | "planned" | "failed",
        "entry": { ...time entry as stored... }, "error": string }
    ],
    "day_totals": [ { "date": string, "weekday": string, "total_human": string, "total_hours": number } ]
  }

Examples:
  - Use when: reconstructing a day from a Slack history -> {"entries": [{"date": "2026-08-20", "duration_hours": 3, "note": "Payment webhook fix", "project_id": 500001}, {"date": "2026-08-20", "duration_hours": 2, "note": "Code review", "project_id": 500001}]}
  - Use when: filling a whole week in one pass -> entries with different 'date' values
  - Use when: you want to see the layout before committing -> add {"dry_run": true}
  - Don't use when: correcting something already logged (use tmetric_update_time_entry)

Error handling:
  - Per-entry failures appear in 'results' with status 'failed' and an explanatory 'error'; 'succeeded' and 'failed' tell you what landed.
  - An overlap with existing time fails only the entry that collides, naming the conflicting span.`,
    inputSchema: bulkInput,
    outputSchema: bulkOutput,
    annotations: CREATES,
    handler: async (args, { client, context }) => {
      const { accountId, userId } = await context.resolve(args.account_id, args.user_id);

      const results = await placeAndCreate(client, accountId, userId, args.entries, {
        allowOverlap: args.allow_overlap,
        dayStartMinutes: timeToMinutes(args.day_start_time, "day_start_time"),
        dryRun: args.dry_run,
      });

      const affectedDates = [...new Set(results.map((result) => result.date))].sort();
      const dayTotals = await Promise.all(
        affectedDates.map(async (date) => {
          const spans = toOccupiedSpans(await fetchDayEntries(client, accountId, userId, date), date);
          const minutes = spans.reduce(
            (sum, span) => (span.endMinutes === null ? sum : sum + (span.endMinutes - span.startMinutes)),
            0,
          );
          return { date, weekday: weekdayOf(date), total_human: formatDuration(minutes), total_hours: toDecimalHours(minutes) };
        }),
      );

      const output = {
        dry_run: args.dry_run,
        requested: args.entries.length,
        succeeded: results.filter((result) => result.status !== "failed").length,
        failed: results.filter((result) => result.status === "failed").length,
        results,
        day_totals: dayTotals,
      };

      return buildToolResult(
        output,
        (value) => {
          const verb = value.dry_run ? "Planned" : "Created";
          const lines = [
            `# ${verb} ${value.succeeded} of ${value.requested} time entries`,
            "",
            ...(value.failed > 0 ? [`**${value.failed} entr${value.failed === 1 ? "y" : "ies"} failed** — see below.`, ""] : []),
            "| # | date | span | duration | status | detail |",
            "| --- | --- | --- | --- | --- | --- |",
          ];
          for (const result of value.results) {
            const spec = args.entries[result.index];
            const detail =
              result.status === "failed"
                ? escapeCell(result.error ?? "unknown error")
                : escapeCell(result.entry?.note ?? result.entry?.task ?? spec?.note ?? spec?.task_name ?? "");
            const span = result.status === "failed" ? "—" : `${result.start_time}–${result.end_time}`;
            lines.push(`| ${result.index} | ${result.date} | ${span} | ${result.duration_human} | ${result.status} | ${detail} |`);
          }
          lines.push("", "## Day totals after this call", "");
          for (const day of value.day_totals) lines.push(`- ${day.date} (${day.weekday}): ${day.total_human}`);
          return lines.join("\n");
        },
        args.response_format as ResponseFormat,
        halveList("results"),
      );
    },
  });

  defineTool(server, deps, {
    name: "tmetric_update_time_entry",
    title: "Correct an existing TMetric time entry",
    description: `Change one existing time entry: its description, project, task, tags, billable flag, times or day.

The current entry is read first and merged with your changes, so fields you do not mention keep their values. That is why 'date' is required — it identifies the day the entry currently sits on.

Args:
  - time_entry_id (number, required): id from tmetric_list_time_entries
  - date (string, required): the day the entry currently sits on
  - new_date (string): move the entry to another day
  - start_time (string), end_time (string): new local HH:mm bounds
  - duration_hours (number) | duration_minutes (number): new length, keeping the start time
  - note (string): replacement description
  - project_id (number): move to another project
  - task_id (number) | task_name (string): relink the task
  - tag_ids (number[]) | tag_names (string[]): replace the tags
  - is_billable (boolean)
  - account_id (number), user_id (number)
  - response_format ('markdown' | 'json')

Returns:
  {
    "updated": boolean,
    "changed_fields": string[],
    "entry": { "id": number, "date": string, "start_time": string, "end_time": string,
               "duration_minutes": number, "duration_hours": number, "duration_human": string,
               "is_running": boolean, "note": string, "task": string,
               "project": { "id": number, "name": string, "client": string },
               "tags": [...], "is_billable": boolean }
  }

Examples:
  - Use when: "that 3 hours was actually 4" -> {"time_entry_id": 987654, "date": "2026-08-20", "duration_hours": 4}
  - Use when: the work was booked to the wrong project -> {"time_entry_id": 987654, "date": "2026-08-20", "project_id": 500002}
  - Use when: fixing a typo in the description -> {"time_entry_id": 987654, "date": "2026-08-20", "note": "Payment webhook fix"}
  - Don't use when: the entry should be removed entirely (use tmetric_delete_time_entry)

Error handling:
  - Returns a 404 listing the ids present on that day when time_entry_id is not on 'date'.
  - Reports a 403 when the workspace has manual time editing disabled, or when the entry is already invoiced.`,
    inputSchema: updateInput,
    outputSchema: updateOutput,
    annotations: UPDATES,
    handler: async (args, { client, context }) => {
      const { accountId, userId } = await context.resolve(args.account_id, args.user_id);
      const currentDate = resolveDate(args.date, "date");
      const existing = await findEntryOnDay(client, accountId, userId, currentDate, args.time_entry_id);

      const existingStart = normalizeApiDateTime(existing.startTime);
      if (!existingStart) {
        throw new TMetricApiError(
          `Time entry ${args.time_entry_id} has no start time and cannot be edited through the API.`,
          undefined,
          "update_time_entry",
        );
      }
      const existingEnd = normalizeApiDateTime(existing.endTime);
      const existingMinutes = existingEnd ? minutesBetween(existingStart, existingEnd) : null;

      if (args.duration_hours !== undefined && args.duration_minutes !== undefined) {
        throw new TMetricApiError(
          "Provide either duration_hours or duration_minutes, not both.",
          undefined,
          "update_time_entry",
        );
      }

      const changed: string[] = [];
      const targetDate = args.new_date ? resolveDate(args.new_date, "new_date") : dateOf(existingStart);
      if (args.new_date) changed.push("date");

      const startMinutes =
        args.start_time !== undefined
          ? timeToMinutes(args.start_time, "start_time")
          : timeToMinutes(timeOf(existingStart), "start_time");
      if (args.start_time !== undefined) changed.push("start_time");

      let durationMinutes: number;
      if (args.end_time !== undefined) {
        const endMinutes = timeToMinutes(args.end_time, "end_time");
        durationMinutes = endMinutes > startMinutes ? endMinutes - startMinutes : endMinutes + 24 * 60 - startMinutes;
        changed.push("end_time");
      } else if (args.duration_minutes !== undefined) {
        durationMinutes = args.duration_minutes;
        changed.push("duration");
      } else if (args.duration_hours !== undefined) {
        durationMinutes = Math.round(args.duration_hours * 60);
        changed.push("duration");
      } else if (existingMinutes !== null) {
        durationMinutes = existingMinutes;
      } else {
        throw new TMetricApiError(
          `Time entry ${args.time_entry_id} is a running timer. Stop it with tmetric_stop_timer before editing its length.`,
          undefined,
          "update_time_entry",
        );
      }

      if (durationMinutes <= 0) {
        throw new TMetricApiError("The resulting entry would have a zero or negative length.", undefined, "update_time_entry");
      }

      const tags =
        args.tag_ids !== undefined || args.tag_names !== undefined
          ? [...(args.tag_ids ?? []).map((id) => ({ id })), ...(args.tag_names ?? []).map((name) => ({ name }))]
          : existing.tags;
      if (args.tag_ids !== undefined || args.tag_names !== undefined) changed.push("tags");

      const task =
        args.task_id !== undefined || args.task_name !== undefined
          ? {
              ...(args.task_id !== undefined ? { id: args.task_id } : {}),
              ...(args.task_name !== undefined ? { name: args.task_name } : {}),
            }
          : existing.task;
      if (args.task_id !== undefined || args.task_name !== undefined) changed.push("task");

      if (args.note !== undefined) changed.push("note");
      if (args.project_id !== undefined) changed.push("project");
      if (args.is_billable !== undefined) changed.push("is_billable");

      const project = args.project_id !== undefined ? { id: args.project_id } : existing.project;

      const payload: TMetricTimeEntry = {
        startTime: localDateTime(targetDate, startMinutes),
        endTime: localDateTime(targetDate, startMinutes + durationMinutes),
        note: args.note ?? existing.note,
        ...(project ? { project } : {}),
        ...(task ? { task } : {}),
        ...(tags?.length ? { tags } : {}),
        ...(args.is_billable !== undefined
          ? { isBillable: args.is_billable }
          : existing.isBillable !== undefined
            ? { isBillable: existing.isBillable }
            : {}),
      };

      const updated = await client.request<TMetricTimeEntry>(
        `/accounts/${accountId}/timeentries/${args.time_entry_id}`,
        { method: "PUT", body: payload },
      );

      const entry = mapTimeEntry(updated ?? { ...payload, id: args.time_entry_id });
      const output = { updated: true, entry, changed_fields: changed };

      return buildToolResult(
        output,
        (value) =>
          [
            `Updated time entry ${args.time_entry_id} (${value.changed_fields.join(", ") || "no field changes"}).`,
            "",
            renderTimeEntryLine(value.entry),
          ].join("\n"),
        args.response_format as ResponseFormat,
      );
    },
  });

  defineTool(server, deps, {
    name: "tmetric_delete_time_entry",
    title: "Delete a TMetric time entry",
    description: `Permanently remove one time entry from the workspace.

This cannot be undone, so confirm the target with tmetric_list_time_entries first and check that the id, day and description match what the human meant.

Args:
  - time_entry_id (number, required): id from tmetric_list_time_entries
  - account_id (number): workspace id (default: your active workspace)
  - response_format ('markdown' | 'json')

Returns:
  { "deleted": boolean, "time_entry_id": number, "message": string }

Examples:
  - Use when: "delete the duplicate 2-hour entry from Tuesday" -> {"time_entry_id": 987654}
  - Don't use when: the entry only needs different values (use tmetric_update_time_entry)

Error handling:
  - Returns a 404 when the id does not exist in the workspace.
  - Returns a 403 when the entry is already invoiced or approved on a submitted timesheet.`,
    inputSchema: deleteInput,
    outputSchema: deleteOutput,
    annotations: DELETES,
    handler: async (args, { client, context }) => {
      const accountId = await context.resolveAccountId(args.account_id);
      await client.request<void>(`/accounts/${accountId}/timeentries/${args.time_entry_id}`, { method: "DELETE" });

      const output = {
        deleted: true,
        time_entry_id: args.time_entry_id,
        message: `Time entry ${args.time_entry_id} was deleted from workspace ${accountId}.`,
      };

      return buildToolResult(output, (value) => value.message, args.response_format as ResponseFormat);
    },
  });

  defineTool(server, deps, {
    name: "tmetric_list_recent_time_entries",
    title: "List recently tracked work",
    description: `Return the task, project and tag combinations you tracked most recently.

Use it to reuse an existing description and project pairing instead of inventing new ones, which keeps reports clean. Items are the shortcuts TMetric shows in its "recent" list; they carry no times of their own.

Args:
  - account_id (number): workspace id (default: your active workspace)
  - user_id (number): whose recent list to read (default: yourself)
  - limit (number): 1-500 items (default: 50)
  - offset (number): items to skip (default: 0)
  - response_format ('markdown' | 'json')

Returns:
  {
    "total": number, "count": number, "offset": number, "has_more": boolean,
    "recent_entries": [
      { "note": string, "task": string, "task_id": number,
        "project": { "id": number, "name": string, "client": string, "is_billable": boolean },
        "tags": [ { "id": number, "name": string } ],
        "is_billable": boolean, "is_pinned": boolean }
    ]
  }

Examples:
  - Use when: "log two more hours on the same thing as yesterday" -> {"limit": 10}
  - Use when: you need a plausible project_id for work described only in prose -> {}
  - Don't use when: you need actual logged times (use tmetric_list_time_entries)`,
    inputSchema: recentInput,
    outputSchema: recentOutput,
    annotations: READ_ONLY,
    handler: async (args, { client, context }) => {
      const { accountId, userId } = await context.resolve(args.account_id, args.user_id);
      const raw = await client.request<TMetricRecentTimeEntry[]>(`/accounts/${accountId}/timeentries/recent`, {
        query: { userId },
      });

      const items = (raw ?? []).map((item) => ({
        ...(item.note ? { note: item.note } : {}),
        ...(item.task?.name ? { task: item.task.name } : {}),
        ...(item.task?.id !== undefined ? { task_id: item.task.id } : {}),
        ...(item.project ? { project: mapProject(item.project) } : {}),
        ...(item.tags?.length ? { tags: item.tags.map(mapTag) } : {}),
        ...(item.isBillable !== undefined ? { is_billable: item.isBillable } : {}),
        ...(item.isPinned !== undefined ? { is_pinned: item.isPinned } : {}),
      }));

      const { page, meta } = paginate(items, args.limit, args.offset);
      const output: RecentOutput = { ...meta, recent_entries: page };
      return buildToolResult(output, renderRecent, args.response_format as ResponseFormat, halveList("recent_entries"));
    },
  });
}
