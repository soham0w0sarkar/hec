import { DISPLAY_TIMEZONE } from "@hec/core";
import { RetrievalError } from "./errors";

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD HH:mm:ss` in the display timezone. Stored instants stay UTC. */
export function formatIst(instant: Date, timeZone = DISPLAY_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")} ${read("hour")}:${read("minute")}:${read("second")}`;
}

/**
 * UTC instant of 00:00 on that calendar day in the display timezone.
 * The next day's start is the exclusive end. A message at 23:50 stays on this day.
 */
export function istDayStart(day: string, timeZone = DISPLAY_TIMEZONE): Date {
  if (!DAY.test(day)) throw new RetrievalError("invalid_input", "day must be YYYY-MM-DD");
  const instant = zonedStart(day, timeZone);
  if (Number.isNaN(instant.getTime()) || formatIst(instant, timeZone).slice(0, 10) !== day) {
    throw new RetrievalError("invalid_input", "day is not a real date");
  }
  return instant;
}

export function istDayKey(instant: Date, timeZone = DISPLAY_TIMEZONE): string {
  return formatIst(instant, timeZone).slice(0, 10);
}

function zonedStart(day: string, timeZone: string): Date {
  const utcGuess = new Date(`${day}T00:00:00.000Z`);
  const offsetMs = zoneOffsetMs(utcGuess, timeZone);
  return new Date(utcGuess.getTime() - offsetMs);
}

function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(read("year"), read("month") - 1, read("day"), read("hour"), read("minute"), read("second"));
  return asUtc - instant.getTime();
}
