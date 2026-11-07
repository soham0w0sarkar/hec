import type { SQL } from "bun";
import { EMBEDDING_DIMENSIONS, MESSAGE_SOURCES, PERSON_IDS, type MessageSource, type PersonId } from "@hec/core";
import { withCache } from "./cache";
import { MAX_LIMIT } from "./constants";
import { RetrievalError } from "./errors";
import { readDataVersion, runRead, type ReadOptions } from "./query";
import { asCount, asId } from "./rows";
import type { ChunkHit } from "./types";
import type { RetrievalOptions } from "./keyword";

export type ChunkSearch = {
  vector: readonly number[];
  model: string;
  limit?: number;
  /** Inclusive lower bound on the chunk's last message. */
  from?: Date;
  /** Exclusive upper bound on the chunk's first message. A chunk that overlaps the range is kept. */
  until?: Date;
  source?: MessageSource;
  personId?: PersonId;
};

type ChunkRow = {
  id: string | number;
  session_id: string | number;
  first_message_id: string | number;
  last_message_id: string | number;
  message_count: number;
  transcript: string;
  from_at: Date | string;
  until_at: Date | string;
  from_ist: string;
  until_ist: string;
  score: string | number;
  embedding_model: string;
};

/**
 * Nearest chunks for one embedding model. Filters run in the query, before the limit,
 * so a source or date filter does not shrink a top-k taken from the unfiltered table.
 * Vectors stored under a different model are never compared. If every stored vector
 * belongs to some other model, this throws `model_mismatch` instead of looking empty.
 */
export async function searchChunks(
  sql: SQL,
  search: ChunkSearch,
  options: RetrievalOptions = {},
): Promise<{ hits: ChunkHit[] }> {
  const query = prepareChunkSearch(search);
  const version = options.cache ? await readDataVersion(sql) : 0;
  return withCache(version, options.cache, "chunks", query, () => loadChunks(sql, query, options), reviveChunks);
}

export function prepareChunkSearch(search: ChunkSearch): {
  vector: string;
  model: string;
  limit: number;
  from: Date | null;
  until: Date | null;
  source: MessageSource | null;
  personId: PersonId | null;
} {
  if (!Array.isArray(search.vector) || search.vector.length !== EMBEDDING_DIMENSIONS) {
    throw new RetrievalError("invalid_input", `vector must have ${EMBEDDING_DIMENSIONS} numbers`);
  }
  const literal = search.vector.map((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new RetrievalError("invalid_input", "vector values must be finite");
    }
    return String(value);
  });
  if (typeof search.model !== "string" || search.model.trim() === "" || search.model.length > 200) {
    throw new RetrievalError("invalid_input", "embedding model name is missing");
  }
  const limit = search.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RetrievalError("invalid_input", `limit must be a whole number from 1 to ${MAX_LIMIT}`);
  }
  const from = search.from ?? null;
  const until = search.until ?? null;
  if (from && Number.isNaN(from.getTime())) throw new RetrievalError("invalid_input", "from is not a real time");
  if (until && Number.isNaN(until.getTime())) throw new RetrievalError("invalid_input", "until is not a real time");
  if (from && until && from.getTime() > until.getTime()) throw new RetrievalError("invalid_input", "from is after until");
  const source = search.source === undefined ? null : known(MESSAGE_SOURCES, search.source, "source");
  const personId = search.personId === undefined ? null : known(PERSON_IDS, search.personId, "person");
  return { vector: `[${literal.join(",")}]`, model: search.model.trim(), limit, from, until, source, personId };
}

async function loadChunks(
  sql: SQL,
  query: ReturnType<typeof prepareChunkSearch>,
  options: ReadOptions,
): Promise<{ hits: ChunkHit[] }> {
  return runRead(sql, async (tx) => {
    const counts = (await tx.unsafe(
      `select
         count(*) filter (where embedding_model = $1)::int as same,
         count(*) filter (where embedding_model is not null and embedding_model <> $1)::int as other
       from chunks`,
      [query.model],
    )) as { same: number; other: number }[];
    const same = asCount(counts[0]?.same ?? 0);
    const other = asCount(counts[0]?.other ?? 0);
    if (same === 0 && other > 0) {
      throw new RetrievalError("model_mismatch", "stored embeddings are from a different model");
    }
    if (same === 0) return { hits: [] };

    const rows = (await tx.unsafe(
      `select c.id, c.session_id, c.first_message_id, c.last_message_id, c.message_count,
              c.transcript, c.embedding_model,
              f.sent_at as from_at, l.sent_at as until_at,
              format_display_time(f.sent_at) as from_ist,
              format_display_time(l.sent_at) as until_ist,
              (1 - (c.embedding <=> $1::vector))::float8 as score
       from chunks c
       join messages f on f.id = c.first_message_id
       join messages l on l.id = c.last_message_id
       where c.embedding_model = $2
         and c.embedding is not null
         and ($3::timestamptz is null or l.sent_at >= $3)
         and ($4::timestamptz is null or f.sent_at < $4)
         and ($5::text is null or exists (
           select 1 from messages m
           where m.session_id = c.session_id
             and m.sent_at >= f.sent_at and m.sent_at <= l.sent_at
             and m.source = $5::message_source
         ))
         and ($6::text is null or exists (
           select 1 from messages m
           where m.session_id = c.session_id
             and m.sent_at >= f.sent_at and m.sent_at <= l.sent_at
             and m.person_id = $6
         ))
       order by c.embedding <=> $1::vector, c.id
       limit $7`,
      [
        query.vector,
        query.model,
        query.from?.toISOString() ?? null,
        query.until?.toISOString() ?? null,
        query.source,
        query.personId,
        query.limit,
      ],
    )) as ChunkRow[];
    return { hits: rows.map(toChunkHit) };
  }, options);
}

function toChunkHit(row: ChunkRow): ChunkHit {
  const from = row.from_at instanceof Date ? row.from_at : new Date(row.from_at);
  const until = row.until_at instanceof Date ? row.until_at : new Date(row.until_at);
  const score = typeof row.score === "number" ? row.score : Number(row.score);
  if (Number.isNaN(from.getTime()) || Number.isNaN(until.getTime()) || !Number.isFinite(score)) {
    throw new Error(`bad chunk row ${row.id}`);
  }
  return {
    id: asId(row.id),
    sessionId: asId(row.session_id),
    firstMessageId: asId(row.first_message_id),
    lastMessageId: asId(row.last_message_id),
    messageCount: asCount(row.message_count),
    transcript: row.transcript,
    from,
    until,
    fromIst: row.from_ist,
    untilIst: row.until_ist,
    score,
    model: row.embedding_model,
  };
}

function reviveChunks(value: { hits: ChunkHit[] }): { hits: ChunkHit[] } {
  return {
    hits: value.hits.map((hit) => ({ ...hit, from: new Date(hit.from), until: new Date(hit.until) })),
  };
}

function known<T extends string>(allowed: readonly T[], value: string, label: string): T {
  if (!(allowed as readonly string[]).includes(value)) throw new RetrievalError("invalid_input", `unknown ${label}`);
  return value as T;
}
