/**
 * Zod building blocks reused across tool input and output schemas.
 */

import { z } from "zod";
import { DEFAULT_PAGE_SIZE } from "../constants.js";
import { DATE_RE, TIME_RE } from "../utils/datetime.js";
import { RESPONSE_FORMATS } from "../utils/format.js";

/** Output format selector present on every read tool. */
export const responseFormatSchema = z
  .enum(RESPONSE_FORMATS)
  .default("markdown")
  .describe("Output format: 'markdown' for a compact human-readable summary, 'json' for full structured data.");

/** Optional workspace override; omit to use the active workspace. */
export const accountIdSchema = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(
    "TMetric workspace id. Omit to use TMETRIC_ACCOUNT_ID, or the active workspace from your profile. Call tmetric_get_current_user to list workspace ids.",
  );

/** Optional user override; omit to act on your own timeline. */
export const userIdSchema = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(
    "TMetric user id whose timeline is affected. Omit to use TMETRIC_USER_ID, or your own id. Reading other users' time requires team-view permission.",
  );

/** Calendar date, or a relative keyword resolved on the server. */
export const dateSchema = z
  .string()
  .refine((value) => DATE_RE.test(value) || ["today", "yesterday", "tomorrow"].includes(value.toLowerCase()), {
    message: "Expected a date as YYYY-MM-DD (for example 2026-08-20), or 'today' / 'yesterday' / 'tomorrow'.",
  });

/** Wall-clock time on a 24-hour clock. */
export const clockTimeSchema = z
  .string()
  .regex(TIME_RE, "Expected a 24-hour clock time such as '09:30' or '17:00'.");

export const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(500)
  .default(DEFAULT_PAGE_SIZE)
  .describe(`Maximum number of items to return (default ${DEFAULT_PAGE_SIZE}).`);

export const offsetSchema = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe("Number of items to skip, for paging through a longer list.");

/** Pagination fields shared by every list tool's output schema. */
export const pageMetaShape = {
  total: z.number().int().describe("Total number of matching items before paging."),
  count: z.number().int().describe("Number of items in this response."),
  offset: z.number().int().describe("Offset this page starts at."),
  has_more: z.boolean().describe("Whether more items are available beyond this page."),
  next_offset: z.number().int().optional().describe("Offset to pass next to continue paging."),
  truncated: z.boolean().optional().describe("True when the response was shortened to fit the size limit."),
  truncation_message: z.string().optional().describe("Explains what was dropped when 'truncated' is true."),
} as const;

/** Compact project reference used inside several outputs. */
export const projectRefShape = {
  id: z.number().int().optional(),
  name: z.string().optional(),
  client: z.string().optional(),
  is_billable: z.boolean().optional(),
} as const;

export const projectRefSchema = z.object(projectRefShape);

/** Compact tag reference. */
export const tagRefSchema = z.object({
  id: z.number().int().optional(),
  name: z.string().optional(),
  is_work_type: z.boolean().optional(),
});

/** The normalised shape every tool uses to describe a time entry. */
export const timeEntryShape = {
  id: z.number().int().optional().describe("Time entry id, used by update and delete tools."),
  date: z.string().describe("Local calendar date the entry starts on (YYYY-MM-DD)."),
  start_time: z.string().nullable().describe("Local start time as HH:mm."),
  end_time: z.string().nullable().describe("Local end time as HH:mm, or null while the timer is running."),
  duration_minutes: z.number().describe("Length of the entry in minutes; for a running timer, elapsed so far."),
  duration_hours: z.number().describe("Same duration expressed as decimal hours."),
  duration_human: z.string().describe("Human-readable duration, e.g. '3h 25m'."),
  is_running: z.boolean().describe("True when the entry has no end time and the timer is still active."),
  note: z.string().optional().describe("Free-form description of the work."),
  task: z.string().optional().describe("Name of the linked task, when any."),
  task_id: z.number().int().optional(),
  project: projectRefSchema.optional().describe("Project the entry is booked to."),
  tags: z.array(tagRefSchema).optional(),
  is_billable: z.boolean().optional(),
  is_invoiced: z.boolean().optional(),
  external_link: z.string().optional().describe("URL of the linked issue in an integrated system."),
} as const;

export const timeEntrySchema = z.object(timeEntryShape);
export type TimeEntryOutput = z.infer<typeof timeEntrySchema>;
