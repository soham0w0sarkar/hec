// BullMQ worker for the offline pipeline. Runs extraction jobs from the Redis Cloud queue.
// Start it with `bun run worker` and leave it running while `bun run extract` works.
import { createDb } from "@hec/db";
import {
  createExtractionHandler,
  createExtractionModel,
  createSqlStore,
  describeFailure,
  loadPrompt,
  retrievalFirstLookup,
} from "@hec/extraction";
import { createExtractionQueue, createExtractionWorker } from "@hec/queue";

const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 8;

function concurrencyFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_CONCURRENCY;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_CONCURRENCY) {
    throw new Error(`EXTRACTION_CONCURRENCY must be a whole number from 1 to ${MAX_CONCURRENCY}`);
  }
  return value;
}

const concurrency = concurrencyFromEnv(process.env.EXTRACTION_CONCURRENCY);
const sql = createDb(process.env.DATABASE_URL, { max: concurrency + 2 });
const queue = createExtractionQueue(process.env.REDIS_URL);
const model = createExtractionModel();

const handler = createExtractionHandler({
  store: createSqlStore(sql),
  model,
  prompt: loadPrompt(),
  firstLookup: retrievalFirstLookup(sql),
  queue,
  log: (line) => console.log(line),
});

const worker = createExtractionWorker(process.env.REDIS_URL, handler, {
  concurrency,
  // The Sarvam Pay-as-you-go limit for sarvam-105b is 60 requests a minute. A job makes one request per window.
  maxJobsPerMinute: 20,
});

worker.on("failed", (job, error) => {
  console.error(`job ${job?.name ?? "?"} ${job?.id ?? "?"} failed: ${describeFailure(error)}`);
});

console.log(`extraction worker ready: model ${model.model}, ${concurrency} at a time`);

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`${signal}: finishing current jobs`);
  await worker.close();
  await queue.close();
  await sql.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
