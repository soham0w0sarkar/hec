import type { ExtractionJob, JobSink } from "@hec/queue";
import type { ChatModel } from "@hec/llm";
import type { FirstLookup } from "./firsts";
import { runExtractSession, runFinalizeRun, type JobDeps } from "./jobs";
import type { ExtractionPrompt } from "./prompt";
import type { ExtractionStore } from "./store";

export type HandlerDeps = {
  store: ExtractionStore;
  model: ChatModel;
  prompt: ExtractionPrompt;
  firstLookup: FirstLookup;
  queue: JobSink;
  log?: (line: string) => void;
};

/** The function the worker app registers for the extraction queue. Routes by job name. */
export function createExtractionHandler(deps: HandlerDeps): (job: ExtractionJob) => Promise<void> {
  const jobDeps: JobDeps = {
    store: deps.store,
    model: deps.model,
    prompt: deps.prompt,
    firstLookup: deps.firstLookup,
    enqueueFinalize: (runId) => deps.queue.enqueue({ name: "finalize-run", data: { runId } }),
    log: deps.log,
  };

  return async (job) => {
    switch (job.name) {
      case "extract-session":
        await runExtractSession(jobDeps, job.data);
        return;
      case "finalize-run":
        await runFinalizeRun(jobDeps, job.data);
        return;
      default: {
        const unknown: never = job;
        throw new Error(`unknown extraction job ${(unknown as { name: string }).name}`);
      }
    }
  };
}
