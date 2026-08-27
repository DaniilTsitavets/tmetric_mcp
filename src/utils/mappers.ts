/**
 * Conversion from raw TMetric API payloads to the flattened, agent-friendly
 * shapes declared in `schemas/common.ts`, plus the Markdown renderers that go
 * with them. Keeping this in one place means every tool describes a time entry,
 * a project or a tag identically.
 */

import type { TimeEntryOutput } from "../schemas/common.js";
import type {
  TMetricProjectBasic,
  TMetricTagBasic,
  TMetricTimeEntry,
  TMetricTimeEntryProject,
  TMetricTimeEntryTag,
} from "../types.js";
import {
  dateOf,
  formatDuration,
  minutesBetween,
  normalizeApiDateTime,
  timeOf,
  toDecimalHours,
} from "./datetime.js";
import { escapeCell, joinParts } from "./format.js";

/** Current local wall-clock time as a naive timestamp, used to size running timers. */
function nowLocal(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:00`;
}

export function mapProject(project: TMetricProjectBasic | undefined) {
  if (!project) return undefined;
  return {
    ...(project.id !== undefined ? { id: project.id } : {}),
    ...(project.name !== undefined ? { name: project.name } : {}),
    ...(project.client?.name ? { client: project.client.name } : {}),
    ...(project.isBillable !== undefined ? { is_billable: project.isBillable } : {}),
  };
}

export function mapTag(tag: TMetricTagBasic) {
  return {
    ...(tag.id !== undefined ? { id: tag.id } : {}),
    ...(tag.name !== undefined ? { name: tag.name } : {}),
    ...(tag.isWorkType !== undefined ? { is_work_type: tag.isWorkType } : {}),
  };
}

/** Flattens one API time entry, computing duration and running-timer state. */
export function mapTimeEntry(entry: TMetricTimeEntry): TimeEntryOutput {
  const start = normalizeApiDateTime(entry.startTime);
  const end = normalizeApiDateTime(entry.endTime);
  const isRunning = Boolean(start) && !end;
  const minutes = start ? Math.max(0, minutesBetween(start, end ?? nowLocal())) : 0;

  return {
    ...(entry.id !== undefined ? { id: entry.id } : {}),
    date: start ? dateOf(start) : "",
    start_time: start ? timeOf(start) : null,
    end_time: end ? timeOf(end) : null,
    duration_minutes: minutes,
    duration_hours: toDecimalHours(minutes),
    duration_human: formatDuration(minutes),
    is_running: isRunning,
    ...(entry.note ? { note: entry.note } : {}),
    ...(entry.task?.name ? { task: entry.task.name } : {}),
    ...(entry.task?.id !== undefined ? { task_id: entry.task.id } : {}),
    ...(entry.project ? { project: mapProject(entry.project) } : {}),
    ...(entry.tags?.length ? { tags: entry.tags.map(mapTag) } : {}),
    ...(entry.isBillable !== undefined ? { is_billable: entry.isBillable } : {}),
    ...(entry.isInvoiced !== undefined ? { is_invoiced: entry.isInvoiced } : {}),
    ...(entry.task?.externalLink?.link ? { external_link: entry.task.externalLink.link } : {}),
  };
}

export function mapTimeEntryProject(project: TMetricTimeEntryProject) {
  return {
    id: project.id ?? 0,
    name: project.name ?? "(unnamed)",
    ...(project.client?.name ? { client: project.client.name } : {}),
    ...(project.client?.id !== undefined ? { client_id: project.client.id } : {}),
    ...(project.isBillable !== undefined ? { is_billable: project.isBillable } : {}),
    ...(project.status ? { status: project.status } : {}),
    ...(project.recentUsageTime
      ? { last_used: normalizeApiDateTime(project.recentUsageTime) ?? undefined }
      : {}),
  };
}

export function mapTimeEntryTag(tag: TMetricTimeEntryTag) {
  return {
    id: tag.id ?? 0,
    name: tag.name ?? "(unnamed)",
    is_work_type: tag.isWorkType ?? false,
    ...(tag.isWorkTypeBillable !== undefined ? { is_work_type_billable: tag.isWorkTypeBillable } : {}),
  };
}

/** One Markdown line describing an entry, used in day-by-day listings. */
export function renderTimeEntryLine(entry: TimeEntryOutput): string {
  const span = entry.is_running
    ? `${entry.start_time ?? "??:??"}–running`
    : `${entry.start_time ?? "??:??"}–${entry.end_time ?? "??:??"}`;

  const label = entry.task ?? entry.note ?? "(no description)";
  const meta = joinParts([
    entry.project?.name ? `project: ${entry.project.name}` : undefined,
    entry.project?.client ? `client: ${entry.project.client}` : undefined,
    entry.tags?.length ? `tags: ${entry.tags.map((tag) => tag.name).join(", ")}` : undefined,
    entry.is_billable ? "billable" : undefined,
    entry.is_invoiced ? "invoiced" : undefined,
    entry.id !== undefined ? `id: ${entry.id}` : undefined,
  ]);

  const description = entry.task && entry.note && entry.note !== entry.task ? ` — ${escapeCell(entry.note)}` : "";
  return `- **${span}** (${entry.duration_human}) ${escapeCell(label)}${description}${meta ? `\n  ${meta}` : ""}`;
}
