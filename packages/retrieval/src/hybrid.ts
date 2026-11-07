import type { SQL } from "bun";
import { withCache } from "./cache";
import { DEFAULT_KEYWORD_WEIGHT, DEFAULT_VECTOR_WEIGHT, MAX_LIMIT, RRF_K } from "./constants";
import { RetrievalError } from "./errors";
import { readDataVersion } from "./query";
import type { ChunkHit, KeywordHit, MatchMode, SearchFilters } from "./types";
import { searchMessages, type RetrievalOptions } from "./keyword";
import { searchChunks } from "./vector";

export type HybridSearch = SearchFilters & {
  text: string;
  variants?: readonly string[];
  mode: MatchMode;
  vector: readonly number[];
  model: string;
  limit?: number;
  keywordWeight?: number;
  vectorWeight?: number;
};

export type HybridHit = {
  key: string;
  score: number;
  via: ("keyword" | "vector")[];
  message: KeywordHit | null;
  chunk: ChunkHit | null;
};

/**
 * Reciprocal rank fusion. Rank starts at 1. Score is the sum of weight / (k + rank).
 * The same key in one list counts once, at its best rank. A key in both lists keeps both sources.
 */
export function fuseByRank(
  lists: { via: "keyword" | "vector"; weight: number; ranked: readonly { key: string; rank: number }[] }[],
  k = RRF_K,
): { key: string; score: number; via: ("keyword" | "vector")[] }[] {
  const scores = new Map<string, { key: string; score: number; via: ("keyword" | "vector")[] }>();
  for (const list of lists) {
    const best = new Map<string, number>();
    for (const entry of list.ranked) {
      const current = best.get(entry.key);
      if (current === undefined || entry.rank < current) best.set(entry.key, entry.rank);
    }
    for (const [key, rank] of best) {
      const row = scores.get(key) ?? { key, score: 0, via: [] };
      row.score += list.weight / (k + rank);
      if (!row.via.includes(list.via)) row.via.push(list.via);
      scores.set(key, row);
    }
  }
  return [...scores.values()].sort((left, right) => right.score - left.score || left.key.localeCompare(right.key));
}

/**
 * Keyword hits and chunk hits fused with reciprocal rank fusion.
 * A keyword message that falls inside a returned chunk becomes one hit, tagged with both methods.
 * Chunks no message landed in stay as their own hits. Weights default to 1.
 * Each method contributes at most MAX_LIMIT rows.
 */
export async function hybridSearch(
  sql: SQL,
  search: HybridSearch,
  options: RetrievalOptions = {},
): Promise<{ hits: HybridHit[] }> {
  const limit = search.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RetrievalError("invalid_input", `limit must be a whole number from 1 to ${MAX_LIMIT}`);
  }
  const keywordWeight = search.keywordWeight ?? DEFAULT_KEYWORD_WEIGHT;
  const vectorWeight = search.vectorWeight ?? DEFAULT_VECTOR_WEIGHT;
  if (!Number.isFinite(keywordWeight) || keywordWeight < 0) {
    throw new RetrievalError("invalid_input", "keywordWeight must be zero or more");
  }
  if (!Number.isFinite(vectorWeight) || vectorWeight < 0) {
    throw new RetrievalError("invalid_input", "vectorWeight must be zero or more");
  }
  if (keywordWeight === 0 && vectorWeight === 0) {
    throw new RetrievalError("invalid_input", "both weights are zero");
  }

  const version = options.cache ? await readDataVersion(sql) : 0;
  return withCache(
    version,
    options.cache,
    "hybrid",
    { ...search, limit, keywordWeight, vectorWeight },
    async () => {
      const [keyword, chunks] = await Promise.all([
        searchMessages(sql, { ...search, limit: MAX_LIMIT, order: "asc", after: undefined }, options),
        searchChunks(sql, { ...search, limit: MAX_LIMIT }, options),
      ]);
      return { hits: fuse(keyword.hits, chunks.hits, keywordWeight, vectorWeight).slice(0, limit) };
    },
    (value) => ({
      hits: value.hits.map((hit) => ({
        ...hit,
        message: hit.message ? { ...hit.message, sentAt: new Date(hit.message.sentAt) } : null,
        chunk: hit.chunk ? { ...hit.chunk, from: new Date(hit.chunk.from), until: new Date(hit.chunk.until) } : null,
      })),
    }),
  );
}

function fuse(messages: KeywordHit[], chunks: ChunkHit[], keywordWeight: number, vectorWeight: number): HybridHit[] {
  const keywordRank = [...messages].sort(compareKeyword);
  const items = new Map<string, { message: KeywordHit | null; chunk: ChunkHit | null; time: number }>();
  const keywordSide: { key: string; rank: number }[] = [];
  const vectorSide: { key: string; rank: number }[] = [];

  keywordRank.forEach((message, index) => {
    const chunk = bestChunk(message, chunks);
    const key = `m:${message.id}`;
    items.set(key, { message, chunk, time: message.sentAt.getTime() });
    keywordSide.push({ key, rank: index + 1 });
    if (chunk) {
      const vectorRank = chunks.findIndex((candidate) => candidate.id === chunk.id) + 1;
      vectorSide.push({ key, rank: vectorRank });
    }
  });

  chunks.forEach((chunk, index) => {
    const taken = [...items.values()].some((item) => item.message !== null && item.chunk?.id === chunk.id);
    if (taken) return;
    const key = `c:${chunk.id}`;
    items.set(key, { message: null, chunk, time: chunk.from.getTime() });
    vectorSide.push({ key, rank: index + 1 });
  });

  const fused = fuseByRank(
    [
      { via: "keyword", weight: keywordWeight, ranked: keywordSide },
      { via: "vector", weight: vectorWeight, ranked: vectorSide },
    ],
  );

  return fused
    .map((row) => {
      const item = items.get(row.key);
      return {
        key: row.key,
        score: row.score,
        via: row.via,
        message: item?.message ?? null,
        chunk: item?.chunk ?? null,
        time: item?.time ?? 0,
      };
    })
    .sort((left, right) => right.score - left.score || left.time - right.time || left.key.localeCompare(right.key))
    .map(({ time: _time, ...hit }) => hit);
}

function bestChunk(message: KeywordHit, chunks: ChunkHit[]): ChunkHit | null {
  const inside = chunks.filter(
    (chunk) =>
      message.sessionId !== null &&
      chunk.sessionId === message.sessionId &&
      message.sentAt.getTime() >= chunk.from.getTime() &&
      message.sentAt.getTime() <= chunk.until.getTime(),
  );
  inside.sort((left, right) => right.score - left.score || left.id - right.id);
  return inside[0] ?? null;
}

function compareKeyword(left: KeywordHit, right: KeywordHit): number {
  if (left.match !== right.match) return left.match === "exact" ? -1 : 1;
  if (left.form !== right.form) return left.form === "two" ? -1 : 1;
  if (left.score !== right.score) return right.score - left.score;
  const byTime = left.sentAt.getTime() - right.sentAt.getTime();
  if (byTime !== 0) return byTime;
  const bySource = left.source.localeCompare(right.source);
  if (bySource !== 0) return bySource;
  return left.sourceRef.localeCompare(right.sourceRef);
}
