import type { JobSink } from "@hec/queue";
import type { ExtractionStore } from "./store";

export type StartOptions = { model: string; promptVersion: string };

/**
 * Starts a new run over every session and queues one job per session. Earlier runs are not
 * touched. Their drafts stay as they are, so nothing from two runs is mixed.
 */
export async function startRun(
  store: ExtractionStore,
  jobs: JobSink,
  options: StartOptions,
): Promise<{ runId: number; sessions: number }> {
  const sessionIds = await store.sessionIds();
  if (sessionIds.length === 0) throw new Error("there are no sessions yet. Run `bun run sessionize` first.");

  const runId = await store.createRun({
    model: options.model,
    promptVersion: options.promptVersion,
    sessionCount: sessionIds.length,
  });
  for (const sessionId of sessionIds) {
    await jobs.enqueue({ name: "extract-session", data: { runId, sessionId } });
  }
  return { runId, sessions: sessionIds.length };
}

/**
 * Queues the sessions of an open run that are not succeeded yet, or one named session (to re-run
 * it). If every session is already succeeded, it queues finalize again, in case the last one was
 * lost. Finalize is idempotent, so this is safe to repeat.
 */
export async function resumeRun(
  store: ExtractionStore,
  jobs: JobSink,
  runId: number,
  options: { sessionId?: number } = {},
): Promise<{ queued: number[]; finalizeQueued: boolean }> {
  const run = await store.getRun(runId);
  if (!run) throw new Error(`run ${runId} does not exist`);
  if (run.status !== "running") throw new Error(`run ${runId} is ${run.status}; start a new run instead`);

  const states = await store.sessionStates(runId);
  const targets =
    options.sessionId !== undefined
      ? [options.sessionId]
      : (await store.sessionIds()).filter((id) => states.get(id) !== "succeeded");

  for (const sessionId of targets) {
    await jobs.enqueue({ name: "extract-session", data: { runId, sessionId } });
  }

  const succeeded = [...states.values()].filter((state) => state === "succeeded").length;
  const finalizeQueued = targets.length === 0 && succeeded === run.sessionCount;
  if (finalizeQueued) await jobs.enqueue({ name: "finalize-run", data: { runId } });
  return { queued: targets, finalizeQueued };
}
