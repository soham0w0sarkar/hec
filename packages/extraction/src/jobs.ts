import type { ChatModel } from "@hec/llm";
import type { ExtractionPrompt } from "./prompt";
import type { FirstLookup } from "./firsts";
import { buildFinalEvents } from "./pipeline";
import { extractSession } from "./extract";
import { describeFailure, type ExtractionStore, type FinalizeResult } from "./store";

export type JobDeps = {
  store: ExtractionStore;
  model: ChatModel;
  prompt: ExtractionPrompt;
  firstLookup: FirstLookup;
  /** Called when the last session of a run is saved. Duplicate calls are harmless. */
  enqueueFinalize: (runId: number) => Promise<void>;
  /** Logs ids and counts only. Never message text. */
  log?: (line: string) => void;
};

export type SessionJobResult = "saved" | "skipped" | "failed";

/**
 * Pass 1 for one session. Skips when the run is no longer open. A failure is recorded on the
 * session row and then re-thrown, so the job shows as failed and the CLI can resume it.
 */
export async function runExtractSession(
  deps: JobDeps,
  job: { runId: number; sessionId: number },
): Promise<SessionJobResult> {
  const log = deps.log ?? (() => {});
  const run = await deps.store.getRun(job.runId);
  if (!run) throw new Error(`extraction run ${job.runId} does not exist`);
  if (run.status !== "running") {
    log(`run ${job.runId} is ${run.status}; session ${job.sessionId} skipped`);
    return "skipped";
  }
  // A run has one model and one prompt. A worker started with other settings must not add to it.
  if (run.model !== deps.model.model || run.promptVersion !== deps.prompt.version) {
    throw new Error(
      `run ${job.runId} was started with model ${run.model} and prompt ${run.promptVersion}; this worker uses ${deps.model.model} and ${deps.prompt.version}`,
    );
  }

  const messages = await deps.store.sessionMessages(job.sessionId);
  if (messages === null) {
    await deps.store.saveFailure(job.runId, job.sessionId, "session no longer exists; run sessionize and start a new run");
    log(`session ${job.sessionId} no longer exists`);
    return "failed";
  }

  let result;
  try {
    const labels = await deps.store.speakerLabels();
    result = await extractSession(deps.model, deps.prompt, messages, { labels });
  } catch (error) {
    await deps.store.saveFailure(job.runId, job.sessionId, describeFailure(error));
    log(`session ${job.sessionId} failed: ${describeFailure(error)}`);
    throw error;
  }

  const saved = await deps.store.saveOutcome(job.runId, job.sessionId, {
    windowCount: result.windows,
    proposedCount: result.proposed,
    attempts: result.attempts,
    candidates: result.candidates,
    dropped: result.dropped,
    usage: result.usage,
  });
  if (!saved) {
    log(`run ${job.runId} closed while session ${job.sessionId} was running; result not written`);
    return "skipped";
  }

  log(
    `run ${job.runId} session ${job.sessionId}: windows ${result.windows}, proposed ${result.proposed}, kept ${result.candidates.length}, dropped ${result.dropped.length}, cost ${result.usage.costInr ?? "unknown"} INR`,
  );
  await maybeEnqueueFinalize(deps, job.runId);
  return "saved";
}

/** Enqueues finalize once every session of the run has a succeeded row. */
export async function maybeEnqueueFinalize(deps: JobDeps, runId: number): Promise<boolean> {
  const run = await deps.store.getRun(runId);
  if (!run || run.status !== "running") return false;
  const states = await deps.store.sessionStates(runId);
  const succeeded = [...states.values()].filter((state) => state === "succeeded").length;
  if (succeeded !== run.sessionCount) return false;
  await deps.enqueueFinalize(runId);
  return true;
}

/** Merges, checks firsts, and writes the run's events. Safe to run twice: the second call skips. */
export async function runFinalizeRun(deps: JobDeps, job: { runId: number }): Promise<FinalizeResult> {
  const log = deps.log ?? (() => {});
  const result = await deps.store.finalize(job.runId, (sessions) =>
    buildFinalEvents(sessions, deps.firstLookup),
  );
  if (result.status === "finalized") {
    log(`run ${job.runId} finalized: ${result.events} draft events`);
  } else {
    log(`run ${job.runId} not finalized: ${result.reason}`);
  }
  return result;
}

