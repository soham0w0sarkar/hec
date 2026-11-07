import { createHash } from "node:crypto";
import { CACHE_TTL_SECONDS } from "./constants";

export type RetrievalCache = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
};

export type MemoryRetrievalCache = RetrievalCache & {
  reads: number;
  writes: number;
};

/** Process-local cache. Tests use the read and write counters. */
export function memoryRetrievalCache(): MemoryRetrievalCache {
  const stored = new Map<string, string>();
  const cache: MemoryRetrievalCache = {
    reads: 0,
    writes: 0,
    async get(key) {
      cache.reads += 1;
      return stored.get(key) ?? null;
    },
    async set(key, value) {
      cache.writes += 1;
      stored.set(key, value);
    },
  };
  return cache;
}

/**
 * Optional Redis cache. The value holds result text, so this belongs on your own Redis.
 * Failures are ignored by callers: a cache problem must not fail the search, and nothing is logged.
 */
export async function redisRetrievalCache(url: string): Promise<RetrievalCache & { close(): Promise<void> }> {
  const { default: Redis } = await import("ioredis");
  const redis = new Redis(url, { maxRetriesPerRequest: 1, enableReadyCheck: false, lazyConnect: true });
  await redis.connect();
  return {
    get: (key) => redis.get(key),
    async set(key, value, ttlSeconds) {
      await redis.set(key, value, "EX", ttlSeconds);
    },
    close: () => redis.quit().then(() => undefined),
  };
}

export function cacheKey(version: number, name: string, payload: unknown): string {
  const body = JSON.stringify(canon(payload));
  const hash = createHash("sha256").update(name).update("\0").update(body).digest("hex");
  return `hec:retrieval:v${version}:${name}:${hash}`;
}

export async function withCache<T>(
  version: number,
  cache: RetrievalCache | undefined,
  name: string,
  payload: unknown,
  load: () => Promise<T>,
  revive: (value: T) => T,
): Promise<T> {
  if (!cache) return load();
  const key = cacheKey(version, name, payload);
  try {
    const hit = await cache.get(key);
    if (hit !== null) return revive(JSON.parse(hit) as T);
  } catch {
    // The key is a hash. Do not log it alongside the query.
  }
  const value = await load();
  try {
    await cache.set(key, JSON.stringify(value), CACHE_TTL_SECONDS);
  } catch {
    // A failed write still returns the fresh result.
  }
  return value;
}

function canon(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canon);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = canon((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}
