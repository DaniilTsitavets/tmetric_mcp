/**
 * Placement logic for time entries within a day.
 *
 * The point of this server is retroactive logging: a human says "three hours on
 * the migration, then two on review" without caring about clock times. These
 * helpers turn durations into concrete, non-overlapping local timestamps by
 * appending to whatever the day already contains.
 */

import type { TMetricTimeEntry } from "../types.js";
import { dateOf, formatDuration, localDateTime, normalizeApiDateTime, timeOf } from "../utils/datetime.js";
import { TMetricApiError, type TMetricClient } from "./client.js";

/** An existing entry reduced to the span it occupies, in minutes from midnight. */
export interface OccupiedSpan {
  id: number | undefined;
  label: string;
  startMinutes: number;
  endMinutes: number | null;
}

/** Minutes from midnight of `date`; entries starting earlier yield a negative value. */
function minutesFromMidnight(dateTime: string, date: string): number {
  const [hours, minutes] = timeOf(dateTime).split(":").map(Number) as [number, number];
  const dayDelta = Math.round(
    (Date.parse(`${dateOf(dateTime)}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000,
  );
  return dayDelta * 24 * 60 + hours * 60 + minutes;
}

/** Fetches the entries TMetric reports for a single day. */
export async function fetchDayEntries(
  client: TMetricClient,
  accountId: number,
  userId: number,
  date: string,
): Promise<TMetricTimeEntry[]> {
  const entries = await client.request<TMetricTimeEntry[]>(`/accounts/${accountId}/timeentries`, {
    query: { userId, startDate: date, endDate: date },
  });
  return entries ?? [];
}

/** Reduces raw entries to the spans they occupy on `date`, sorted chronologically. */
export function toOccupiedSpans(entries: TMetricTimeEntry[], date: string): OccupiedSpan[] {
  return entries
    .filter((entry) => Boolean(entry.startTime))
    .map((entry) => {
      const start = normalizeApiDateTime(entry.startTime) as string;
      const end = normalizeApiDateTime(entry.endTime);
      return {
        id: entry.id,
        label: entry.task?.name ?? entry.note ?? "(no description)",
        startMinutes: minutesFromMidnight(start, date),
        endMinutes: end ? minutesFromMidnight(end, date) : null,
      };
    })
    .filter((span) => span.endMinutes === null || span.endMinutes > 0)
    .sort((a, b) => a.startMinutes - b.startMinutes);
}

/** True when a running timer sits on this day; new entries would collide with it. */
export function findRunningSpan(spans: OccupiedSpan[]): OccupiedSpan | undefined {
  return spans.find((span) => span.endMinutes === null);
}

/**
 * The first minute after everything already logged, so a new entry appends to the
 * end of the day rather than overlapping it.
 */
export function nextFreeMinute(spans: OccupiedSpan[], fallbackStartMinutes: number): number {
  const latestEnd = spans.reduce<number | null>((latest, span) => {
    if (span.endMinutes === null) return latest;
    return latest === null || span.endMinutes > latest ? span.endMinutes : latest;
  }, null);
  return latestEnd === null ? fallbackStartMinutes : Math.max(latestEnd, fallbackStartMinutes);
}

/** Returns the first span that overlaps `[startMinutes, endMinutes)`, if any. */
export function findOverlap(
  spans: OccupiedSpan[],
  startMinutes: number,
  endMinutes: number,
): OccupiedSpan | undefined {
  return spans.find((span) => {
    const spanEnd = span.endMinutes ?? Number.POSITIVE_INFINITY;
    return span.startMinutes < endMinutes && spanEnd > startMinutes;
  });
}

/** Renders a span as `09:00–12:00` for use in error messages. */
export function describeSpan(span: OccupiedSpan, date: string): string {
  const start = timeOf(localDateTime(date, span.startMinutes));
  const end = span.endMinutes === null ? "running" : timeOf(localDateTime(date, span.endMinutes));
  const id = span.id === undefined ? "" : ` (id ${span.id})`;
  return `${start}–${end} ${span.label}${id}`;
}

/**
 * Raises the standard overlap error, naming the conflicting entry and the escape
 * hatch, so the agent can fix the call instead of guessing.
 */
export function throwOverlapError(conflict: OccupiedSpan, date: string, endpoint: string): never {
  throw new TMetricApiError(
    `The requested slot on ${date} overlaps an existing entry: ${describeSpan(conflict, date)}. ` +
      `Omit start_time to append after the last entry of the day, choose a free slot, or pass allow_overlap=true to let TMetric adjust the neighbouring entry.`,
    undefined,
    endpoint,
  );
}

/** Total logged minutes on a day, ignoring any still-running timer. */
export function totalLoggedMinutes(spans: OccupiedSpan[]): number {
  return spans.reduce((sum, span) => (span.endMinutes === null ? sum : sum + (span.endMinutes - span.startMinutes)), 0);
}

/** Human summary of a day's load, used in confirmation messages. */
export function describeDayLoad(spans: OccupiedSpan[]): string {
  return `${spans.length} entr${spans.length === 1 ? "y" : "ies"}, ${formatDuration(totalLoggedMinutes(spans))} logged`;
}
