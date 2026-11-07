// Redis (Redis Cloud in this setup) and BullMQ. Job names and payloads live here so the producer
// (CLI) and the consumer (worker) cannot drift apart.
import { Queue, Worker, type ConnectionOptions, type Job, type JobsOptions } from "bullmq";

export const EXTRACTION_QUEUE = "extraction";

export type ExtractionJob =
  | { name: "extract-session"; data: { runId: number; sessionId: number } }
  | { name: "finalize-run"; data: { runId: number } };

export type ExtractionJobName = ExtractionJob["name"];

/** Anything that can accept an extraction job. The extraction package depends on this, not on BullMQ. */
export type JobSink = {
  enqueue(job: ExtractionJob): Promise<void>;
};

/**
 * Turns REDIS_URL into BullMQ connection options. Accepts `redis://` and `rediss://` (TLS), with
 * or without credentials. BullMQ opens its own connections from these options, so no connection
 * is shared between the queue and the worker.
 */
export function redisOptionsFromUrl(url: string | undefined): ConnectionOptions {
  if (!url || url.trim() === "") throw new Error("REDIS_URL is not set");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("REDIS_URL is not a valid URL");
  }
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    throw new Error("REDIS_URL must start with redis:// or rediss://");
  }
  const options: ConnectionOptions = {
    host: parsed.hostname,
    port: parsed.port === "" ? 6379 : Number(parsed.port),
    // BullMQ workers block on Redis; a request must not give up after a fixed number of retries.
    maxRetriesPerRequest: null,
  };
  if (parsed.username) options.username = decodeURIComponent(parsed.username);
  if (parsed.password) options.password = decodeURIComponent(parsed.password);
  if (parsed.protocol === "rediss:") options.tls = {};
  const db = parsed.pathname.slice(1);
  if (db !== "" && /^\d+$/.test(db)) options.db = Number(db);
  return options;
}

/**
 * Job options. One attempt only: the LLM client already retries transient errors, and a BullMQ
 * retry would pay for the whole session again.
 */
const SINGLE_ATTEMPT: JobsOptions = {
  attempts: 1,
  removeOnComplete: true,
  removeOnFail: 500,
};

export class ExtractionQueue implements JobSink {
  constructor(private readonly queue: Queue) {}

  async enqueue(job: ExtractionJob): Promise<void> {
    if (job.name === "finalize-run") {
      // One finalize per run. A second request for the same run is ignored while one is queued.
      await this.queue.add(job.name, job.data, { ...SINGLE_ATTEMPT, jobId: `finalize-${job.data.runId}` });
      return;
    }
    // Unique id: a session can be re-run in the same run, and BullMQ ignores a duplicate id.
    const nonce = crypto.randomUUID().slice(0, 8);
    await this.queue.add(job.name, job.data, {
      ...SINGLE_ATTEMPT,
      jobId: `extract-${job.data.runId}-${job.data.sessionId}-${nonce}`,
    });
  }

  close(): Promise<void> {
    return this.queue.close();
  }
}

export function createExtractionQueue(redisUrl: string | undefined): ExtractionQueue {
  return new ExtractionQueue(new Queue(EXTRACTION_QUEUE, { connection: redisOptionsFromUrl(redisUrl) }));
}

export type WorkerOptions = {
  concurrency: number;
  /** Jobs allowed per window. Keeps a burst from exceeding the model's requests-per-minute limit. */
  maxJobsPerMinute: number;
};

/** Starts a worker for the extraction queue. `handle` gets each job and its name and payload. */
export function createExtractionWorker(
  redisUrl: string | undefined,
  handle: (job: ExtractionJob) => Promise<void>,
  options: WorkerOptions,
): Worker {
  return new Worker(
    EXTRACTION_QUEUE,
    async (job: Job) => {
      await handle(job as unknown as ExtractionJob);
    },
    {
      connection: redisOptionsFromUrl(redisUrl),
      concurrency: options.concurrency,
      limiter: { max: options.maxJobsPerMinute, duration: 60_000 },
    },
  );
}
