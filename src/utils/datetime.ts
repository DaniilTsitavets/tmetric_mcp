/**
 * Date and time helpers.
 *
 * The TMetric API exchanges *naive local* timestamps ("2026-08-20T09:00:00") that
 * are interpreted in the workspace timezone. Sending a UTC offset or a "Z" suffix
 * silently shifts the entry to the wrong day, so every value produced here is a
 * plain local string and all arithmetic is done on the parsed components rather
 * than on `Date` objects in the process timezone.
 */

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;
export const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

const MINUTES_PER_DAY = 24 * 60;

/** Two-digit zero padding. */
function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Formats a `Date` as a local `YYYY-MM-DD` string (no UTC conversion). */
export function toLocalDateString(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Today's date in the server's local timezone, as `YYYY-MM-DD`. */
export function today(): string {
  return toLocalDateString(new Date());
}

/**
 * Resolves a date input to `YYYY-MM-DD`.
 *
 * Accepts an explicit date or the keywords `today` / `yesterday` / `tomorrow`,
 * which are resolved against the server's local clock.
 *
 * @throws {Error} when the value is neither a keyword nor a valid calendar date.
 */
export function resolveDate(value: string, fieldName = "date"): string {
  const raw = value.trim().toLowerCase();

  if (raw === "today" || raw === "yesterday" || raw === "tomorrow") {
    const offset = raw === "yesterday" ? -1 : raw === "tomorrow" ? 1 : 0;
    const base = new Date();
    base.setDate(base.getDate() + offset);
    return toLocalDateString(base);
  }

  if (!DATE_RE.test(raw)) {
    throw new Error(
      `Invalid ${fieldName}: '${value}'. Expected the format YYYY-MM-DD (for example 2026-08-20), or one of 'today', 'yesterday', 'tomorrow'.`,
    );
  }

  const [year, month, day] = raw.split("-").map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new Error(`Invalid ${fieldName}: '${value}' is not a real calendar date.`);
  }

  return raw;
}

/** Converts `HH:mm` (or `HH:mm:ss`) to minutes since midnight. */
export function timeToMinutes(value: string, fieldName = "time"): number {
  const match = TIME_RE.exec(value.trim());
  if (!match) {
    throw new Error(
      `Invalid ${fieldName}: '${value}'. Expected a 24-hour clock time such as '09:30' or '17:00'.`,
    );
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Adds `days` to a `YYYY-MM-DD` string. */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/**
 * Builds a naive local timestamp from a date and an offset in minutes from that
 * date's midnight. Offsets of 24h or more roll into the following days, which is
 * how entries that cross midnight are represented.
 */
export function localDateTime(date: string, minutesFromMidnight: number): string {
  const dayOffset = Math.floor(minutesFromMidnight / MINUTES_PER_DAY);
  const withinDay = minutesFromMidnight - dayOffset * MINUTES_PER_DAY;
  const day = dayOffset === 0 ? date : addDays(date, dayOffset);
  return `${day}T${pad(Math.floor(withinDay / 60))}:${pad(withinDay % 60)}:00`;
}

/** The `YYYY-MM-DD` part of a naive local timestamp. */
export function dateOf(dateTime: string): string {
  return dateTime.slice(0, 10);
}

/** The `HH:mm` part of a naive local timestamp. */
export function timeOf(dateTime: string): string {
  return dateTime.slice(11, 16);
}

/** Absolute minutes of a naive local timestamp, for ordering and differences. */
function absoluteMinutes(dateTime: string): number {
  const [year, month, day] = dateOf(dateTime).split("-").map(Number) as [number, number, number];
  const [hours, minutes] = timeOf(dateTime).split(":").map(Number) as [number, number];
  return Date.UTC(year, month - 1, day, hours, minutes) / 60_000;
}

/** Whole minutes between two naive local timestamps. Negative when `end` precedes `start`. */
export function minutesBetween(start: string, end: string): number {
  return absoluteMinutes(end) - absoluteMinutes(start);
}

/** Renders a duration in minutes as `3h 25m`, `45m` or `0m`. */
export function formatDuration(minutes: number): string {
  const rounded = Math.round(minutes);
  const sign = rounded < 0 ? "-" : "";
  const total = Math.abs(rounded);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${sign}${rest}m`;
  if (rest === 0) return `${sign}${hours}h`;
  return `${sign}${hours}h ${rest}m`;
}

/** Renders a duration in seconds as `3h 25m`. */
export function formatSeconds(seconds: number): string {
  return formatDuration(seconds / 60);
}

/** Minutes rendered as decimal hours with two digits, e.g. `3.42`. */
export function toDecimalHours(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100;
}

/**
 * Normalises a timestamp coming back from the API. TMetric occasionally returns a
 * fractional-seconds suffix; trimming it keeps rendering stable.
 */
export function normalizeApiDateTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.exec(value);
  return match ? (match[1] as string) : value;
}
