import type { SQL } from "bun";
import { MESSAGE_SOURCES, PERSON_IDS, type MessageSource, type PersonId } from "@hec/core";
import { withCache } from "./cache";
import { MAX_LIMIT, MAX_STAT_DAYS } from "./constants";
import { RetrievalError } from "./errors";
import { readDataVersion, runRead } from "./query";
import { asCount } from "./rows";
import { istDayStart } from "./time";
import { PERIODS, type Period } from "./types";
import type { RetrievalOptions } from "./keyword";

export type StatFilters = {
  personId?: PersonId;
  source?: MessageSource;
  /** Inclusive calendar day, `YYYY-MM-DD`, in the display timezone. */
  fromDay?: string;
  /** Exclusive calendar day. */
  untilDay?: string;
};

export type Streaks = {
  longest: number;
  /** The streak that ends on the latest day in range. */
  current: number;
  longestFrom: string | null;
  longestUntil: string | null;
  truncated: boolean;
};

/**
 * If an ingest committed messages and then crashed before the refresh, the stats
 * view is behind `data_version`. The next stats read refreshes it.
 */
async function ensureFresh(sql: SQL, options: RetrievalOptions): Promise<void> {
  await runRead(sql, async (tx) => {
    const rows = (await tx`select data_version, stats_version from app_settings where id = 1`) as {
      data_version: string | number;
      stats_version: string | number;
    }[];
    const dataVersion = Number(rows[0]?.data_version);
    const statsVersion = Number(rows[0]?.stats_version);
    if (statsVersion < dataVersion) await tx`select refresh_daily_stats()`;
  }, options);
}

export async function busiestDays(
  sql: SQL,
  filters: StatFilters & { limit?: number } = {},
  options: RetrievalOptions = {},
): Promise<{ days: { day: string; messages: number }[] }> {
  const limit = filters.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RetrievalError("invalid_input", `limit must be a whole number from 1 to ${MAX_LIMIT}`);
  }
  const prepared = prepareStats(filters);
  return cached(sql, options, "busiest", { ...prepared, limit }, async () => {
    await ensureFresh(sql, options);
    return runRead(sql, async (tx) => {
      const rows = (await tx.unsafe(
        `select day::text as day, sum(message_count)::int as messages
         from daily_stats
         where ($1::text is null or person_id = $1)
           and ($2::text is null or source = $2::message_source)
           and ($3::date is null or day >= $3::date)
           and ($4::date is null or day < $4::date)
         group by day
         order by messages desc, day asc
         limit $5`,
        [...statParams(prepared), limit],
      )) as { day: string; messages: number }[];
      return { days: rows.map((row) => ({ day: row.day, messages: asCount(row.messages) })) };
    }, options);
  });
}

export async function streaks(sql: SQL, filters: StatFilters = {}, options: RetrievalOptions = {}): Promise<Streaks> {
  const prepared = prepareStats(filters);
  return cached(sql, options, "streaks", prepared, async () => {
    await ensureFresh(sql, options);
    return runRead(sql, async (tx) => {
      const rows = (await tx.unsafe(
        `select distinct day::text as day
         from daily_stats
         where ($1::text is null or person_id = $1)
           and ($2::text is null or source = $2::message_source)
           and ($3::date is null or day >= $3::date)
           and ($4::date is null or day < $4::date)
         order by day
         limit $5`,
        [...statParams(prepared), MAX_STAT_DAYS + 1],
      )) as { day: string }[];
      const truncated = rows.length > MAX_STAT_DAYS;
      return { ...walkStreaks(rows.slice(0, MAX_STAT_DAYS).map((row) => row.day)), truncated };
    }, options);
  });
}

/** Days on which each person sent the earliest message. Ties go to the lower person id. */
export async function whoMessagesFirst(
  sql: SQL,
  filters: Omit<StatFilters, "personId"> = {},
  options: RetrievalOptions = {},
): Promise<{ days: { personId: PersonId; days: number }[] }> {
  const prepared = prepareStats(filters);
  return cached(sql, options, "first-sender", prepared, async () => {
    await ensureFresh(sql, options);
    return runRead(sql, async (tx) => {
      const rows = (await tx.unsafe(
        `with per_person as (
           select day, person_id, min(first_message_at) as first_at
           from daily_stats
           where ($1::text is null or source = $1::message_source)
             and ($2::date is null or day >= $2::date)
             and ($3::date is null or day < $3::date)
           group by day, person_id
         ),
         winners as (
           select distinct on (day) day, person_id
           from per_person
           order by day, first_at, person_id
         )
         select person_id, count(*)::int as days
         from winners
         group by person_id
         order by person_id`,
        [prepared.source, prepared.fromDay, prepared.untilDay],
      )) as { person_id: string; days: number }[];
      return {
        days: rows.map((row) => ({
          personId: assertAllowed(PERSON_IDS, row.person_id, "person"),
          days: asCount(row.days),
        })),
      };
    }, options);
  });
}

export async function callCounts(
  sql: SQL,
  filters: StatFilters = {},
  options: RetrievalOptions = {},
): Promise<{ calls: number; messages: number }> {
  const prepared = prepareStats(filters);
  return cached(sql, options, "calls", prepared, async () => {
    await ensureFresh(sql, options);
    return runRead(sql, async (tx) => {
      const rows = (await tx.unsafe(
        `select coalesce(sum(call_count), 0)::int as calls,
                coalesce(sum(message_count), 0)::int as messages
         from daily_stats
         where ($1::text is null or person_id = $1)
           and ($2::text is null or source = $2::message_source)
           and ($3::date is null or day >= $3::date)
           and ($4::date is null or day < $4::date)`,
        statParams(prepared),
      )) as { calls: number; messages: number }[];
      return { calls: asCount(rows[0]?.calls ?? 0), messages: asCount(rows[0]?.messages ?? 0) };
    }, options);
  });
}

/** Message and call totals per day, Monday-start week, or month, from daily_stats. */
export async function countsPerPeriod(
  sql: SQL,
  filters: StatFilters & { period: Period; limit?: number },
  options: RetrievalOptions = {},
): Promise<{ periods: { period: string; messages: number; calls: number }[]; truncated: boolean }> {
  if (!(PERIODS as readonly string[]).includes(filters.period)) {
    throw new RetrievalError("invalid_input", "period must be day, week, or month");
  }
  const limit = filters.limit ?? MAX_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RetrievalError("invalid_input", `limit must be a whole number from 1 to ${MAX_LIMIT}`);
  }
  const prepared = prepareStats(filters);
  return cached(sql, options, "stat-periods", { ...prepared, period: filters.period, limit }, async () => {
    await ensureFresh(sql, options);
    return runRead(sql, async (tx) => {
      const rows = (await tx.unsafe(
        `select period, sum(message_count)::int as messages, sum(call_count)::int as calls
         from (
           select case $5::text
             when 'day' then to_char(day, 'YYYY-MM-DD')
             when 'week' then to_char(date_trunc('week', day::timestamp), 'YYYY-MM-DD')
             when 'month' then to_char(day, 'YYYY-MM')
           end as period,
           message_count,
           call_count
           from daily_stats
           where ($1::text is null or person_id = $1)
             and ($2::text is null or source = $2::message_source)
             and ($3::date is null or day >= $3::date)
             and ($4::date is null or day < $4::date)
         ) grouped
         group by period
         order by period
         limit $6`,
        [...statParams(prepared), filters.period, limit + 1],
      )) as { period: string | null; messages: number; calls: number }[];
      const truncated = rows.length > limit;
      return {
        truncated,
        periods: rows.slice(0, limit).map((row) => ({
          period: row.period ?? "",
          messages: asCount(row.messages),
          calls: asCount(row.calls),
        })),
      };
    }, options);
  });
}

export function walkStreaks(days: readonly string[]): Omit<Streaks, "truncated"> {
  let longest = 0;
  let run = 0;
  let runStart: string | null = null;
  let longestFrom: string | null = null;
  let longestUntil: string | null = null;
  let previous: string | null = null;
  for (const day of days) {
    if (previous !== null && nextDay(previous) === day) run += 1;
    else {
      run = 1;
      runStart = day;
    }
    if (run > longest) {
      longest = run;
      longestFrom = runStart;
      longestUntil = day;
    }
    previous = day;
  }
  return { longest, current: run, longestFrom, longestUntil };
}

function nextDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (date ?? 1) + 1)).toISOString().slice(0, 10);
}

async function cached<T>(
  sql: SQL,
  options: RetrievalOptions,
  name: string,
  payload: unknown,
  load: () => Promise<T>,
): Promise<T> {
  const version = options.cache ? await readDataVersion(sql) : 0;
  return withCache(version, options.cache, name, payload, load, (value) => value);
}

function prepareStats(filters: StatFilters): { personId: string | null; source: string | null; fromDay: string | null; untilDay: string | null } {
  const personId = filters.personId === undefined ? null : assertAllowed(PERSON_IDS, filters.personId, "person");
  const source = filters.source === undefined ? null : assertAllowed(MESSAGE_SOURCES, filters.source, "source");
  const fromDay = filters.fromDay === undefined ? null : checkedDay(filters.fromDay);
  const untilDay = filters.untilDay === undefined ? null : checkedDay(filters.untilDay);
  if (fromDay && untilDay && fromDay > untilDay) throw new RetrievalError("invalid_input", "fromDay is after untilDay");
  return { personId, source, fromDay, untilDay };
}

function checkedDay(day: string): string {
  istDayStart(day);
  return day;
}

function statParams(filters: { personId: string | null; source: string | null; fromDay: string | null; untilDay: string | null }): unknown[] {
  return [filters.personId, filters.source, filters.fromDay, filters.untilDay];
}

function assertAllowed<T extends string>(allowed: readonly T[], value: string, label: string): T {
  if (!(allowed as readonly string[]).includes(value)) throw new RetrievalError("invalid_input", `unknown ${label}`);
  return value as T;
}
