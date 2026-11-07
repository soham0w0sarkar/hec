import type { SQL } from "bun";
import {
  COUNTED_MESSAGE_KINDS,
  MESSAGE_KINDS,
  MESSAGE_SOURCES,
  PERSON_IDS,
  type MessageKind,
  type MessageSource,
  type PersonId,
} from "@hec/core";
import { withCache, type RetrievalCache } from "./cache";
import {
  DEFAULT_LIMIT,
  DEFAULT_RUNNERS_UP,
  MAX_LIMIT,
  MAX_PERIODS,
  MAX_QUERY_CHARS,
  MAX_RUNNERS_UP,
  MAX_VARIANTS,
  MIN_TRIGRAM_LENGTH,
  TRIGRAM_WORD_SIMILARITY,
} from "./constants";
import { RetrievalError } from "./errors";
import { readDataVersion, runRead, type ReadOptions } from "./query";
import { MESSAGE_COLUMNS, asCount, asForm, toMessageHit, type MessageRow } from "./rows";
import { MATCH_MODES, PERIODS, type FoldForm, type KeywordHit, type MatchMode, type Period, type SearchFilters } from "./types";

const TEXTS = `array(select jsonb_array_elements_text($5::jsonb))`;

const FILTERS = `
  ($1::text is null or m.person_id = $1)
  and ($2::text is null or m.source = $2::message_source)
  and ($3::timestamptz is null or m.sent_at >= $3)
  and ($4::timestamptz is null or m.sent_at < $4)
  and m.kind = any (array(select jsonb_array_elements_text($7::jsonb))::message_kind[])
  and ($6::boolean or length(btrim(m."text")) > 0)`;

/**
 * Keyword search. `mode` chooses the match and there is no silent fallback.
 * `phrase` is adjacent words, `any_word` is those words in any order, `fuzzy` is trigram
 * word similarity at TRIGRAM_WORD_SIMILARITY. Letter runs and emoji are folded in the database
 * with search_fold, the same function the index uses. `two` is preferred over `one`.
 * `variants` are extra spellings from the caller, OR-ed into this same query. Retrieval does not invent any.
 * Order is sent_at, then source, then source_ref. `from` is inclusive, `until` is exclusive.
 * System, unsent, and empty messages are left out unless the filters say otherwise.
 */
export type KeywordSearch = SearchFilters & {
  text: string;
  variants?: readonly string[];
  mode: MatchMode;
  limit?: number;
  order?: "asc" | "desc";
  after?: string;
};

export type KeywordPage = {
  mode: MatchMode;
  total: number;
  hits: KeywordHit[];
  next: string | null;
};

export type RankedMatches = {
  mode: MatchMode;
  total: number;
  hit: KeywordHit | null;
  /** The next matches after `hit`, in the same order. Empty when there are no more. */
  runnersUp: KeywordHit[];
};

export type RetrievalOptions = ReadOptions & {
  cache?: RetrievalCache;
};

type Cursor = { sentAt: Date; source: MessageSource; sourceRef: string };

export type PreparedSearch = {
  mode: MatchMode;
  texts: string[];
  personId: PersonId | null;
  source: MessageSource | null;
  kinds: MessageKind[];
  includeEmpty: boolean;
  from: Date | null;
  until: Date | null;
  limit: number;
  order: "asc" | "desc";
  after: Cursor | null;
};

type HitRow = MessageRow & { form: string; score: string | number };

export async function searchMessages(
  sql: SQL,
  search: KeywordSearch,
  options: RetrievalOptions = {},
): Promise<KeywordPage> {
  const query = prepareSearch(search);
  const version = options.cache ? await readDataVersion(sql) : 0;
  return withCache(
    version,
    options.cache,
    "search",
    cachePayload(query),
    () => loadPage(sql, query, options),
    revivePage,
  );
}

/** Earliest match, plus the following few, from the whole history. Not a top-k sample. */
export async function findFirst(
  sql: SQL,
  search: KeywordSearch & { runnersUp?: number },
  options: RetrievalOptions = {},
): Promise<RankedMatches> {
  return ranked(sql, search, "asc", options);
}

/** Latest match, plus the previous few. */
export async function findLast(
  sql: SQL,
  search: KeywordSearch & { runnersUp?: number },
  options: RetrievalOptions = {},
): Promise<RankedMatches> {
  return ranked(sql, search, "desc", options);
}

/** How many messages match. This is a count, not the length of a page. */
export async function countMatches(
  sql: SQL,
  search: KeywordSearch,
  options: RetrievalOptions = {},
): Promise<{ mode: MatchMode; total: number }> {
  const query = prepareSearch({ ...search, limit: 1, after: undefined });
  const version = options.cache ? await readDataVersion(sql) : 0;
  return withCache(
    version,
    options.cache,
    "count",
    cachePayload(query),
    () => runRead(sql, async (tx) => ({ mode: query.mode, total: await countQuery(tx, query) }), options),
    (value) => value,
  );
}

/**
 * Match counts per display-timezone day, week (Monday), or month.
 * The row cap is MAX_PERIODS. `truncated` means later periods were left out.
 */
export async function matchesPerPeriod(
  sql: SQL,
  search: KeywordSearch & { period: Period },
  options: RetrievalOptions = {},
): Promise<{ mode: MatchMode; periods: { period: string; count: number }[]; truncated: boolean }> {
  if (!(PERIODS as readonly string[]).includes(search.period)) {
    throw new RetrievalError("invalid_input", "period must be day, week, or month");
  }
  const query = prepareSearch({ ...search, limit: 1, after: undefined });
  const version = options.cache ? await readDataVersion(sql) : 0;
  return withCache(
    version,
    options.cache,
    "periods",
    { ...cachePayload(query), period: search.period },
    () =>
      runRead(sql, async (tx) => {
        const statement = periodStatement(query, search.period);
        const rows = (await tx.unsafe(statement.sql, statement.params)) as { period: string | null; n: number }[];
        const truncated = rows.length > MAX_PERIODS;
        return {
          mode: query.mode,
          truncated,
          periods: rows.slice(0, MAX_PERIODS).map((row) => ({
            period: row.period ?? "",
            count: asCount(row.n),
          })),
        };
      }, options),
    (value) => value,
  );
}

export function prepareSearch(search: KeywordSearch): PreparedSearch {
  if (!(MATCH_MODES as readonly string[]).includes(search.mode)) {
    throw new RetrievalError("invalid_input", "mode must be phrase, any_word, or fuzzy");
  }
  const personId = search.personId === undefined ? null : knownInput(PERSON_IDS, search.personId, "person");
  const source = search.source === undefined ? null : knownInput(MESSAGE_SOURCES, search.source, "source");
  const kinds =
    search.kinds === undefined
      ? [...COUNTED_MESSAGE_KINDS]
      : search.kinds.map((kind) => knownInput(MESSAGE_KINDS, kind, "kind"));
  if (kinds.length === 0) throw new RetrievalError("invalid_input", "kinds is empty");
  if (search.includeEmpty !== undefined && typeof search.includeEmpty !== "boolean") {
    throw new RetrievalError("invalid_input", "includeEmpty must be true or false");
  }

  const limit = search.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RetrievalError("invalid_input", `limit must be a whole number from 1 to ${MAX_LIMIT}`);
  }
  const order = search.order ?? "asc";
  if (order !== "asc" && order !== "desc") throw new RetrievalError("invalid_input", "order must be asc or desc");

  const from = search.from ?? null;
  const until = search.until ?? null;
  if (from && Number.isNaN(from.getTime())) throw new RetrievalError("invalid_input", "from is not a real time");
  if (until && Number.isNaN(until.getTime())) throw new RetrievalError("invalid_input", "until is not a real time");
  if (from && until && from.getTime() > until.getTime()) throw new RetrievalError("invalid_input", "from is after until");

  return {
    mode: search.mode,
    texts: cleanTexts(search.text, search.variants),
    personId,
    source,
    kinds,
    includeEmpty: search.includeEmpty ?? false,
    from,
    until,
    limit,
    order,
    after: search.after === undefined ? null : parseCursor(search.after),
  };
}

/** The page statement and its parameters. User text is only in the parameters. */
export function pageStatement(query: PreparedSearch): { sql: string; params: unknown[] } {
  const direction = query.order === "asc" ? { op: ">", dir: "asc" } : { op: "<", dir: "desc" };
  const match = matchSql(query.mode);
  const sql = `
    ${match.cte}
    select ${MESSAGE_COLUMNS},
      ${match.form} as form,
      ${match.score} as score
    from messages m
    join people p on p.id = m.person_id
    cross join folded
    where ${FILTERS}
      ${match.where}
      and (
        $8::timestamptz is null
        or (m.sent_at, m.source, m.source_ref) ${direction.op} ($8::timestamptz, $9::message_source, $10)
      )
    order by m.sent_at ${direction.dir}, m.source ${direction.dir}, m.source_ref ${direction.dir}
    limit $11`;
  return {
    sql,
    params: [
      ...baseParams(query),
      query.after?.sentAt.toISOString() ?? null,
      query.after?.source ?? null,
      query.after?.sourceRef ?? null,
      query.limit + 1,
    ],
  };
}

/** `<base64url json>`. Opaque; pass it back as `after`. */
export function encodeCursor(hit: { sentAt: Date; source: MessageSource; sourceRef: string }): string {
  return Buffer.from(
    JSON.stringify({ t: hit.sentAt.toISOString(), s: hit.source, r: hit.sourceRef }),
    "utf8",
  ).toString("base64url");
}

export function parseCursor(value: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new RetrievalError("invalid_input", "cursor is not valid");
  }
  if (parsed === null || typeof parsed !== "object") throw new RetrievalError("invalid_input", "cursor is not valid");
  const record = parsed as { t?: unknown; s?: unknown; r?: unknown };
  const sentAt = new Date(typeof record.t === "string" ? record.t : "");
  if (Number.isNaN(sentAt.getTime())) throw new RetrievalError("invalid_input", "cursor is not valid");
  if (record.s !== "instagram" && record.s !== "whatsapp") {
    throw new RetrievalError("invalid_input", "cursor is not valid");
  }
  if (typeof record.r !== "string" || record.r.length === 0 || record.r.length > 500) {
    throw new RetrievalError("invalid_input", "cursor is not valid");
  }
  return { sentAt, source: record.s, sourceRef: record.r };
}

async function ranked(
  sql: SQL,
  search: KeywordSearch & { runnersUp?: number },
  order: "asc" | "desc",
  options: RetrievalOptions,
): Promise<RankedMatches> {
  const runnersUp = search.runnersUp ?? DEFAULT_RUNNERS_UP;
  if (!Number.isInteger(runnersUp) || runnersUp < 0 || runnersUp > MAX_RUNNERS_UP) {
    throw new RetrievalError("invalid_input", `runnersUp must be a whole number from 0 to ${MAX_RUNNERS_UP}`);
  }
  const query = prepareSearch({ ...search, order, limit: runnersUp + 1, after: undefined });
  const version = options.cache ? await readDataVersion(sql) : 0;
  return withCache(
    version,
    options.cache,
    order === "asc" ? "first" : "last",
    { ...cachePayload(query), runnersUp },
    async () => {
      const page = await loadPage(sql, query, options);
      const [hit, ...rest] = page.hits;
      return { mode: page.mode, total: page.total, hit: hit ?? null, runnersUp: rest };
    },
    (value) => ({
      ...value,
      hit: value.hit ? reviveHit(value.hit) : null,
      runnersUp: value.runnersUp.map(reviveHit),
    }),
  );
}

async function loadPage(sql: SQL, query: PreparedSearch, options: ReadOptions): Promise<KeywordPage> {
  return runRead(
    sql,
    async (tx) => {
      const total = await countQuery(tx, query);
      if (total === 0) return { mode: query.mode, total: 0, hits: [], next: null };
      const statement = pageStatement(query);
      const rows = (await tx.unsafe(statement.sql, statement.params)) as HitRow[];
      const more = rows.length > query.limit;
      const hits = rows.slice(0, query.limit).map((row) => toKeywordHit(row, query.mode));
      const last = hits.at(-1);
      return { mode: query.mode, total, hits, next: more && last ? encodeCursor(last) : null };
    },
    options,
  );
}

async function countQuery(tx: SQL, query: PreparedSearch): Promise<number> {
  const match = matchSql(query.mode);
  const rows = (await tx.unsafe(
    `${match.cte}
     select count(*)::int as n
     from messages m
     cross join folded
     where ${FILTERS}
       ${match.where}`,
    baseParams(query),
  )) as { n: number }[];
  return asCount(rows[0]?.n ?? 0);
}

function periodStatement(query: PreparedSearch, period: Period): { sql: string; params: unknown[] } {
  const match = matchSql(query.mode);
  const sql = `
    ${match.cte}
    select period, count(*)::int as n
    from (
      select case $8::text
        when 'day' then to_char(m.sent_at at time zone (select display_timezone from app_settings), 'YYYY-MM-DD')
        when 'week' then to_char(date_trunc('week', m.sent_at at time zone (select display_timezone from app_settings)), 'YYYY-MM-DD')
        when 'month' then to_char(m.sent_at at time zone (select display_timezone from app_settings), 'YYYY-MM')
      end as period
      from messages m
      cross join folded
      where ${FILTERS}
        ${match.where}
    ) grouped
    group by period
    order by period
    limit $9`;
  return { sql, params: [...baseParams(query), period, MAX_PERIODS + 1] };
}

function matchSql(mode: MatchMode): { cte: string; where: string; form: string; score: string } {
  if (mode === "fuzzy") return fuzzySql();
  const tokenMode = mode === "phrase" ? "phrase" : "any_word";
  return {
    cte: `
      with folded as (
        select
          search_tsquery(${TEXTS}, 'two', '${tokenMode}') as q_two,
          search_tsquery(${TEXTS}, 'one', '${tokenMode}') as q_one,
          search_emoji_query(${TEXTS}) as emoji
      )`,
    where: `
      and (cardinality(folded.emoji) > 0 or folded.q_two is not null or folded.q_one is not null)
      and (
        (folded.q_two is null and folded.q_one is null)
        or m.search_vector_two @@ folded.q_two
        or m.search_vector_one @@ folded.q_one
      )
      and (cardinality(folded.emoji) = 0 or m.search_emoji @> folded.emoji)`,
    form: `
      case
        when folded.q_two is not null and m.search_vector_two @@ folded.q_two then 'two'
        when folded.q_two is null and folded.q_one is null then 'two'
        else 'one'
      end`,
    score: `1::float8`,
  };
}

function fuzzySql(): { cte: string; where: string; form: string; score: string } {
  const min = String(MIN_TRIGRAM_LENGTH);
  const threshold = String(TRIGRAM_WORD_SIMILARITY);
  return {
    cte: `
      with folded as (
        select search_emoji_query(${TEXTS}) as emoji
      )`,
    where: `
      and (
        cardinality(folded.emoji) > 0
        or exists (
          select 1 from unnest(${TEXTS}) as raw
          where char_length(search_fold(raw, 'two')) >= ${min}
             or char_length(search_fold(raw, 'one')) >= ${min}
        )
      )
      and (
        not exists (
          select 1 from unnest(${TEXTS}) as raw
          where char_length(search_fold(raw, 'two')) >= ${min}
             or char_length(search_fold(raw, 'one')) >= ${min}
        )
        or exists (
          select 1 from unnest(${TEXTS}) as raw
          where (
            char_length(search_fold(raw, 'two')) >= ${min}
            and search_fold(raw, 'two') <<% m.search_fold_two
          ) or (
            char_length(search_fold(raw, 'one')) >= ${min}
            and search_fold(raw, 'one') <<% m.search_fold_one
          )
        )
      )
      and (cardinality(folded.emoji) = 0 or m.search_emoji @> folded.emoji)`,
    form: `
      case
        when exists (
          select 1 from unnest(${TEXTS}) as raw
          where char_length(search_fold(raw, 'two')) >= ${min}
            and word_similarity(search_fold(raw, 'two'), m.search_fold_two) >= ${threshold}
        ) then 'two'
        else 'one'
      end`,
    score: `
      greatest(
        coalesce((
          select max(word_similarity(search_fold(raw, 'two'), m.search_fold_two))
          from unnest(${TEXTS}) as raw
          where char_length(search_fold(raw, 'two')) >= ${min}
        ), 0),
        coalesce((
          select max(word_similarity(search_fold(raw, 'one'), m.search_fold_one))
          from unnest(${TEXTS}) as raw
          where char_length(search_fold(raw, 'one')) >= ${min}
        ), 0)
      )::float8`,
  };
}

function baseParams(query: PreparedSearch): unknown[] {
  return [
    query.personId,
    query.source,
    query.from?.toISOString() ?? null,
    query.until?.toISOString() ?? null,
    query.texts,
    query.includeEmpty,
    query.kinds,
  ];
}

function cleanTexts(text: string, variants: readonly string[] | undefined): string[] {
  if (typeof text !== "string") throw new RetrievalError("invalid_input", "search text is empty");
  const primary = text.trim();
  if (primary === "") throw new RetrievalError("invalid_input", "search text is empty");
  if (primary.length > MAX_QUERY_CHARS) throw new RetrievalError("invalid_input", "search text is too long");
  const extra = variants ?? [];
  if (extra.length > MAX_VARIANTS) throw new RetrievalError("invalid_input", "too many variants");
  const texts = [primary];
  const seen = new Set([primary.toLowerCase()]);
  for (const variant of extra) {
    if (typeof variant !== "string") throw new RetrievalError("invalid_input", "variant is not text");
    const trimmed = variant.trim();
    if (trimmed === "") continue;
    if (trimmed.length > MAX_QUERY_CHARS) throw new RetrievalError("invalid_input", "variant is too long");
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    texts.push(trimmed);
  }
  return texts;
}

function cachePayload(query: PreparedSearch) {
  return {
    texts: query.texts,
    mode: query.mode,
    personId: query.personId,
    source: query.source,
    kinds: query.kinds,
    includeEmpty: query.includeEmpty,
    from: query.from,
    until: query.until,
    limit: query.limit,
    order: query.order,
    after: query.after,
  };
}

function toKeywordHit(row: HitRow, mode: MatchMode): KeywordHit {
  const score = typeof row.score === "number" ? row.score : Number(row.score);
  if (!Number.isFinite(score)) throw new Error(`bad score for message ${row.id}`);
  return {
    ...toMessageHit(row),
    match: mode === "fuzzy" ? "fuzzy" : "exact",
    form: asForm(row.form),
    score,
  };
}

function revivePage(page: KeywordPage): KeywordPage {
  return { ...page, hits: page.hits.map(reviveHit) };
}

function reviveHit(hit: KeywordHit): KeywordHit {
  return { ...hit, sentAt: new Date(hit.sentAt) };
}

function knownInput<T extends string>(allowed: readonly T[], value: string, label: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new RetrievalError("invalid_input", `unknown ${label}`);
  }
  return value as T;
}
