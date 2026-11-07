import { DISPLAY_TIMEZONE } from "@hec/core";

type Parts = { year: number; month: number; day: number; hour: number; minute: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

function partsOf(date: Date, zone: string): Parts {
  const found: Record<string, number> = {};
  for (const part of formatterFor(zone).formatToParts(date)) {
    if (part.type !== "literal") found[part.type] = Number(part.value);
  }
  return {
    year: found.year as number,
    month: found.month as number,
    day: found.day as number,
    hour: found.hour as number,
    minute: found.minute as number,
  };
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** `2026-03-04`, the calendar day in `zone`. */
export function dayKey(date: Date, zone = DISPLAY_TIMEZONE): string {
  const p = partsOf(date, zone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** `2026-03`, the calendar month in `zone`. */
export function monthKey(date: Date, zone = DISPLAY_TIMEZONE): string {
  return dayKey(date, zone).slice(0, 7);
}

/** `2026-03-04 21:07`, the form the model sees and writes. */
export function formatLocal(date: Date, zone = DISPLAY_TIMEZONE): string {
  const p = partsOf(date, zone);
  return `${dayKey(date, zone)} ${pad(p.hour)}:${pad(p.minute)}`;
}

export type LocalGranularity = "minute" | "day" | "month";

const LOCAL = /^(\d{4})-(\d{2})(?:-(\d{2})(?:[ T](\d{2}):(\d{2}))?)?$/;

/**
 * Reads `YYYY-MM-DD HH:mm`, `YYYY-MM-DD` or `YYYY-MM` as a wall-clock time in `zone`.
 * A bare day means noon, a bare month means noon on the 1st. Returns null for anything else,
 * including impossible dates.
 */
export function parseLocal(
  input: string,
  zone = DISPLAY_TIMEZONE,
): { instant: Date; granularity: LocalGranularity } | null {
  const match = LOCAL.exec(input.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = match[3] === undefined ? 1 : Number(match[3]);
  const hour = match[4] === undefined ? 12 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const granularity: LocalGranularity = match[5] !== undefined ? "minute" : match[3] !== undefined ? "day" : "month";

  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(wall);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute
  ) {
    return null;
  }

  const offsetAt = (instant: number) => {
    const p = partsOf(new Date(instant), zone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(instant / 60_000) * 60_000;
  };
  let instant = wall - offsetAt(wall);
  instant = wall - offsetAt(instant);
  return { instant: new Date(instant), granularity };
}
