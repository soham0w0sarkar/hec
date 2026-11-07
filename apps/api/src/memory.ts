import type { HistoryTurn } from "@hec/agent";
import Redis from "ioredis";

export type ChatMemory = {
  load(id: string): Promise<HistoryTurn[]>;
  append(id: string, turns: readonly HistoryTurn[]): Promise<void>;
};

const MAX_TURNS = 20;
const TURN_CHARS = 2000;
const TTL_SECONDS = 60 * 60 * 24 * 14;

/** Keeps the last 20 turns for one conversation. Content is clipped. */
export function redisChatMemory(url: string): ChatMemory & { close(): Promise<void> } {
  if (!url.trim()) throw new Error("REDIS_URL is not set");
  return createRedisMemory(url);
}

function createRedisMemory(url: string): ChatMemory & { close(): Promise<void> } {
  const redis = new Redis(url, { maxRetriesPerRequest: 2, enableReadyCheck: true });
  redis.on("error", () => {
    console.error("redis chat memory error");
  });

  return {
    async load(id: string) {
      const rows = await redis.lrange(key(id), 0, MAX_TURNS - 1);
      return rows.map(parseTurn).filter((turn): turn is HistoryTurn => turn !== null);
    },
    async append(id: string, turns: readonly HistoryTurn[]) {
      const name = key(id);
      if (turns.length === 0) return;
      const values = turns.map((turn) => JSON.stringify({ role: turn.role, content: turn.content.slice(0, TURN_CHARS) }));
      await redis.rpush(name, ...values);
      await redis.ltrim(name, -MAX_TURNS, -1);
      await redis.expire(name, TTL_SECONDS);
    },
    close() {
      return redis.quit().then(() => undefined);
    },
  };
}

function key(id: string): string {
  return `hec:chat:${id}`;
}

function parseTurn(raw: string): HistoryTurn | null {
  try {
    const value = JSON.parse(raw) as { role?: unknown; content?: unknown };
    if ((value.role !== "user" && value.role !== "assistant") || typeof value.content !== "string") return null;
    return { role: value.role, content: value.content.slice(0, TURN_CHARS) };
  } catch {
    return null;
  }
}
