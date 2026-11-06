import { createDb } from "@hec/db";
import { SESSION_GAP_MS } from "./group";
import { sessionize } from "./store";
import { parseWorkerCount } from "./workers";

if (import.meta.main) {
  const workers = parseWorkerCount(process.argv.slice(2), process.env.SESSION_WORKERS);
  const sql = createDb(process.env.DATABASE_URL, { max: workers + 1 });
  const startedAt = Date.now();
  try {
    console.log(`sessionize with ${workers} workers`);
    const { sessions, messages, slices } = await sessionize(sql, {
      workers,
      onSlice: (slice) => console.log(`[w${slice.worker}] assigned ${slice.assigned}`),
    });
    const first = sessions[0];
    const last = sessions.at(-1);
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`done in ${seconds}s: sessions ${sessions.length}, messages ${messages}, slices ${slices}`);
    console.log(`gap ${SESSION_GAP_MS / (60 * 60 * 1000)}h`);
    if (first && last) {
      console.log(`from ${first.startedAt.toISOString()} to ${last.endedAt.toISOString()}`);
    }
  } finally {
    await sql.close();
  }
}
