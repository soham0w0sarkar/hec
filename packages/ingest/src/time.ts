import { IngestError } from "./errors";

export type ClockParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export function zonedLocalToUtc(parts: ClockParts, timeZone: string): Date {
  if (!isCalendarDate(parts.year, parts.month, parts.day)) {
    throw new IngestError(`invalid date ${parts.year}-${parts.month}-${parts.day}`);
  }

  const utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offset = zoneOffsetMs(utcGuess, timeZone);
  let result = new Date(utcGuess - offset);
  const offsetAgain = zoneOffsetMs(result.getTime(), timeZone);
  if (offsetAgain !== offset) result = new Date(utcGuess - offsetAgain);

  const back = partsInZone(result, timeZone);
  if (
    back.year !== parts.year ||
    back.month !== parts.month ||
    back.day !== parts.day ||
    back.hour !== parts.hour ||
    back.minute !== parts.minute ||
    back.second !== parts.second
  ) {
    throw new IngestError(
      `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} does not exist in ${timeZone}`,
    );
  }

  return result;
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  return new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day;
}

function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const local = partsInZone(new Date(utcMs), timeZone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return asUtc - utcMs;
}

function partsInZone(date: Date, timeZone: string): ClockParts {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const value: Record<string, string> = {};
  for (const part of formatted) value[part.type] = part.value;

  let hour = Number(value.hour);
  let day = Number(value.day);
  if (hour === 24) {
    hour = 0;
    day += 1;
  }

  return {
    year: Number(value.year),
    month: Number(value.month),
    day,
    hour,
    minute: Number(value.minute),
    second: Number(value.second),
  };
}
