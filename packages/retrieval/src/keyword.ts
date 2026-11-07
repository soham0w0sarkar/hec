import type { SQL } from "bun";
import {
  COUNTED_MESSAGE_KINDS,
  MESSAGE_KINDS,
  MESSAGE_SOURCES,
  PERSON_IDS,
  SEARCH_REGCONFIG,
  type MessageKind,
  type MessageSource,
  type PersonId,
} from "@hec/core";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** Trigram needs three characters. Shorter queries stay on full text. */
const MIN_TRIGRAM_LENGTH = 3;

// $1 person, $2 source, $3 from, $4 until, $5 text. Paging adds $6 cursor time, $7 cursor id, $8 limit.
const MATCH = {
  phrase: `m.search_vector @@ phraseto_tsquery('${SEARCH_REGCONFIG}', $5)`,
  plain: `m.search_vector @@ plainto_tsquery('${SEARCH_REGCONFIG}', $5)`,
  trigram: `$5 <<% m."text"`,
} as const;

type MatchKey = keyof typeof MATCH;

const DIRECTION = {
  asc: { sql: "asc", after: ">" },
  desc: { sql: "desc", after: "<" },
} as const;

export type KeywordMode = "phrase" | "fulltext" | "trigram" | "none";

export type KeywordHit = {
  id: number;
  personId: PersonId;
  name: string;
  sentAt: Date;
  text: string;
  source: MessageSource;
  sourceRef: string;
  kind: MessageKind;
};

export type KeywordSearch = {
  text: string;
  personId?: PersonId;
  source?: MessageSource;
  kinds?: readonly MessageKind[];
  from?: Date;
  /** Exclusive. */
  until?: Date;
  limit?: number;
  order?: "asc" | "desc";
  /** Adjacent words. Defaults to true when the text has more than one word. */
  phrase?: boolean;
  /** The `next` cursor from the previous page. */
  after?: string;
};

export type KeywordPage = {
  mode: KeywordMode;
  /** Every match for these filters, not only this page. */
  total: number;
  hits: KeywordHit[];
  /** Pass as `after` to get the next page. Null on the last page. */
  next: string | null;
};

type Row = {
  id: string | number;
  person_id: string;
  name: string;
  sent_at: Date | string;
  text: string;
  source: string;
  source_ref: string;
  kind: string;
};

type Cursor = { sentAt: Date; id: number };

type Normalized = {
  text: string;
  phrase: boolean;
  personId: PersonId | null;
  source: MessageSource | null;
  kinds: MessageKind[];
  from: Date | null;
  until: Date | null;
  limit: number;
  order: "asc" | "desc";
  after: Cursor | null;
};

/**
 * Keyword search over messages. Results come in `sent_at` order (earliest first unless
 * `order` is `desc`), and `total` counts every match for the filters.
 * A phrase query runs first when the text has more than one word. If it has no matches,
 * the words are matched on their own. If that also has none, a trigram comparison catches
 * a longer word with a typo. The mode used is the first one with any match.
 * System and unsent lines are left out unless `kinds` says otherwise.
 */
export async function searchMessages(sql: SQL, search: KeywordSearch): Promise<KeywordPage> {
  const query = normalize(search);

  for (const [mode, match] of candidates(query)) {
    const total = await count(sql, query, match);
    if (total === 0) continue;

    const rows = await page(sql, query, match);
    const more = rows.length > query.limit;
    const hits = rows.slice(0, query.limit).map(toHit);
    const last = hits.at(-1);
    return { mode, total, hits, next: more && last ? encodeCursor(last) : null };
  }

  return { mode: "none", total: 0, hits: [], next: null };
}

/** The earliest message that matches, and which comparison found it. */
export async function firstMessage(
  sql: SQL,
  search: KeywordSearch,
): Promise<{ mode: KeywordMode; hit: KeywordHit | null }> {
  const result = await searchMessages(sql, { ...search, order: "asc", limit: 1, after: undefined });
  return { mode: result.mode, hit: result.hits[0] ?? null };
}

export function normalize(search: KeywordSearch): Normalized {
  const text = search.text.trim();
  if (text === "") throw new Error("search text is empty");

  const personId = search.personId === undefined ? null : known(PERSON_IDS, search.personId, "person");
  const source = search.source === undefined ? null : known(MESSAGE_SOURCES, search.source, "source");
  const kinds =
    search.kinds === undefined
      ? [...COUNTED_MESSAGE_KINDS]
      : search.kinds.map((kind) => known(MESSAGE_KINDS, kind, "kind"));
  if (kinds.length === 0) throw new Error("kinds is empty");

  const limit = search.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
  }

  const order = search.order ?? "asc";
  if (order !== "asc" && order !== "desc") throw new Error("order must be asc or desc");

  if (search.from && search.until && search.from.getTime() > search.until.getTime()) {
    throw new Error("from is after until");
  }

  return {
    text,
    phrase: search.phrase ?? /\s/.test(text),
    personId,
    source,
    kinds,
    from: search.from ?? null,
    until: search.until ?? null,
    limit,
    order,
    after: search.after === undefined ? null : parseCursor(search.after),
  };
}

/** `<ISO time>|<message id>`. Opaque to callers; they pass it back as `after`. */
export function encodeCursor(hit: { sentAt: Date; id: number }): string {
  return `${hit.sentAt.toISOString()}|${hit.id}`;
}

export function parseCursor(value: string): Cursor {
  const bar = value.indexOf("|");
  if (bar === -1) throw new Error("cursor is not valid");
  const sentAt = new Date(value.slice(0, bar));
  const id = Number(value.slice(bar + 1));
  if (Number.isNaN(sentAt.getTime()) || !Number.isSafeInteger(id) || id < 1) {
    throw new Error("cursor is not valid");
  }
  return { sentAt, id };
}

function candidates(query: Normalized): [KeywordMode, MatchKey][] {
  const found: [KeywordMode, MatchKey][] = [];
  if (query.phrase) found.push(["phrase", "phrase"]);
  found.push(["fulltext", "plain"]);
  if (query.text.length >= MIN_TRIGRAM_LENGTH) found.push(["trigram", "trigram"]);
  return found;
}

function kindsList(query: Normalized): string {
  // Kinds are checked against MESSAGE_KINDS in normalize, so inlining them is safe.
  return query.kinds.map((kind) => `'${kind}'`).join(", ");
}

function filterParams(query: Normalized): (string | null)[] {
  return [
    query.personId,
    query.source,
    query.from?.toISOString() ?? null,
    query.until?.toISOString() ?? null,
    query.text,
  ];
}

const FILTERS = `
  ($1::text is null or m.person_id = $1)
  and ($2::text is null or m.source = $2::message_source)
  and ($3::timestamptz is null or m.sent_at >= $3)
  and ($4::timestamptz is null or m.sent_at < $4)`;

async function count(sql: SQL, query: Normalized, match: MatchKey): Promise<number> {
  const rows = (await sql.unsafe(
    `select count(*)::int as n
     from messages m
     where m.kind in (${kindsList(query)})
       and ${FILTERS}
       and ${MATCH[match]}`,
    filterParams(query),
  )) as { n: number }[];
  return rows[0]?.n ?? 0;
}

async function page(sql: SQL, query: Normalized, match: MatchKey): Promise<Row[]> {
  const dir = DIRECTION[query.order];
  // Fetch one extra row to learn whether another page exists.
  return (await sql.unsafe(
    `select m.id, m.person_id, p.name, m.sent_at, m."text", m.source, m.source_ref, m.kind
     from messages m
     join people p on p.id = m.person_id
     where m.kind in (${kindsList(query)})
       and ${FILTERS}
       and ${MATCH[match]}
       and ($6::timestamptz is null or (m.sent_at, m.id) ${dir.after} ($6::timestamptz, $7::bigint))
     order by m.sent_at ${dir.sql}, m.id ${dir.sql}
     limit $8`,
    [
      ...filterParams(query),
      query.after?.sentAt.toISOString() ?? null,
      query.after?.id ?? null,
      query.limit + 1,
    ],
  )) as Row[];
}

function toHit(row: Row): KeywordHit {
  const sentAt = row.sent_at instanceof Date ? row.sent_at : new Date(row.sent_at);
  if (Number.isNaN(sentAt.getTime())) throw new Error(`bad sent_at for message ${row.id}`);
  return {
    id: asId(row.id),
    personId: known(PERSON_IDS, row.person_id, "person"),
    name: row.name,
    sentAt,
    text: row.text,
    source: known(MESSAGE_SOURCES, row.source, "source"),
    sourceRef: row.source_ref,
    kind: known(MESSAGE_KINDS, row.kind, "kind"),
  };
}

function known<T extends string>(allowed: readonly T[], value: string, label: string): T {
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`unknown ${label} "${value}"`);
  return value as T;
}

function asId(value: string | number): number {
  const id = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(id)) throw new Error(`id ${value} is out of range`);
  return id;
}
