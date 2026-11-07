import type { SQL } from "bun";
import { STATEMENT_TIMEOUT_MS, TRIGRAM_WORD_SIMILARITY } from "./constants";
import { RetrievalError, mapQueryError } from "./errors";

export type ReadOptions = {
  timeoutMs?: number;
};

/**
 * One transaction, a statement timeout, and the trigram threshold from constants.
 * pgvector 0.8 can keep filtering inside the HNSW scan; older builds skip that setting.
 */
export async function runRead<T>(sql: SQL, fn: (tx: SQL) => Promise<T>, options: ReadOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? STATEMENT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new RetrievalError("invalid_input", "timeout is out of range");
  }
  try {
    return await sql.begin(async (tx) => {
      const db = tx as unknown as SQL;
      await db.unsafe(`select set_config('statement_timeout', $1, true)`, [`${timeoutMs}ms`]);
      await db.unsafe(`select set_config('pg_trgm.word_similarity_threshold', $1, true)`, [
        String(TRIGRAM_WORD_SIMILARITY),
      ]);
      const iterative = (await db`select name from pg_settings where name = 'hnsw.iterative_scan'`) as {
        name: string;
      }[];
      if (iterative.length > 0) {
        await db.unsafe(`select set_config('hnsw.iterative_scan', 'strict_order', true)`);
      }
      return fn(db);
    });
  } catch (error) {
    throw mapQueryError(error);
  }
}

export async function readDataVersion(sql: SQL): Promise<number> {
  const rows = (await sql`select data_version from app_settings where id = 1`) as {
    data_version: string | number;
  }[];
  const version = Number(rows[0]?.data_version);
  if (!Number.isInteger(version) || version < 0) throw new Error("data_version is missing");
  return version;
}
