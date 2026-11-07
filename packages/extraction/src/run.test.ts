import { describe, expect, test } from "bun:test";
import type { ExtractionJob, JobSink } from "@hec/queue";
import { resumeRun, startRun } from "./run";
import { memoryStore } from "./memory-store";
import { LABELS, msg } from "./test-helpers";

function sink() {
  const jobs: ExtractionJob[] = [];
  const jobSink: JobSink = {
    async enqueue(job) {
      jobs.push(job);
    },
  };
  return { jobs, jobSink };
}

const sessions = {
  1: [msg(1, "2030-01-05 18:00", "person_1", "a")],
  2: [msg(2, "2030-01-06 18:00", "person_2", "b")],
  3: [msg(3, "2030-01-07 18:00", "person_1", "c")],
};

describe("startRun", () => {
  test("one job per session, all in one new run", async () => {
    const store = memoryStore({ labels: LABELS, sessions });
    const { jobs, jobSink } = sink();
    const started = await startRun(store, jobSink, { model: "sarvam-105b", promptVersion: "extract.v1" });

    expect(started).toEqual({ runId: 1, sessions: 3 });
    expect(jobs).toEqual([
      { name: "extract-session", data: { runId: 1, sessionId: 1 } },
      { name: "extract-session", data: { runId: 1, sessionId: 2 } },
      { name: "extract-session", data: { runId: 1, sessionId: 3 } },
    ]);
    expect(store.runs.get(1)).toMatchObject({ model: "sarvam-105b", promptVersion: "extract.v1", sessionCount: 3 });
  });

  test("a second start is a new run and leaves the first alone", async () => {
    const store = memoryStore({ labels: LABELS, sessions });
    const { jobSink } = sink();
    await startRun(store, jobSink, { model: "m", promptVersion: "extract.v1" });
    const second = await startRun(store, jobSink, { model: "m", promptVersion: "extract.v1" });
    expect(second.runId).toBe(2);
    expect(store.runs.get(1)?.status).toBe("running");
  });

  test("refuses when there are no sessions", async () => {
    const store = memoryStore({ labels: LABELS, sessions: {} });
    await expect(startRun(store, sink().jobSink, { model: "m", promptVersion: "p" })).rejects.toThrow(/sessionize/);
  });
});

describe("resumeRun", () => {
  test("queues only the sessions that are not succeeded", async () => {
    const store = memoryStore({ labels: LABELS, sessions });
    const runId = await store.createRun({ model: "m", promptVersion: "p", sessionCount: 3 });
    await store.saveOutcome(runId, 1, {
      windowCount: 1,
      proposedCount: 0,
      attempts: 1,
      candidates: [],
      dropped: [],
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costInr: 0 },
    });
    await store.saveFailure(runId, 2, "boom");

    const { jobs, jobSink } = sink();
    const result = await resumeRun(store, jobSink, runId);
    expect(result).toEqual({ queued: [2, 3], finalizeQueued: false });
    expect(jobs.map((j) => (j.name === "extract-session" ? j.data.sessionId : -1))).toEqual([2, 3]);
  });

  test("re-running one named session queues just that one", async () => {
    const store = memoryStore({ labels: LABELS, sessions });
    const runId = await store.createRun({ model: "m", promptVersion: "p", sessionCount: 3 });
    const { jobs, jobSink } = sink();
    const result = await resumeRun(store, jobSink, runId, { sessionId: 3 });
    expect(result.queued).toEqual([3]);
    expect(jobs).toEqual([{ name: "extract-session", data: { runId, sessionId: 3 } }]);
  });

  test("when everything is already succeeded it queues finalize again", async () => {
    const store = memoryStore({ labels: LABELS, sessions: { 1: sessions[1] } });
    const runId = await store.createRun({ model: "m", promptVersion: "p", sessionCount: 1 });
    await store.saveOutcome(runId, 1, {
      windowCount: 1,
      proposedCount: 0,
      attempts: 1,
      candidates: [],
      dropped: [],
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costInr: 0 },
    });
    const { jobs, jobSink } = sink();
    const result = await resumeRun(store, jobSink, runId);
    expect(result).toEqual({ queued: [], finalizeQueued: true });
    expect(jobs).toEqual([{ name: "finalize-run", data: { runId } }]);
  });

  test("a finished run cannot be resumed", async () => {
    const store = memoryStore({ labels: LABELS, sessions: { 1: sessions[1] } });
    const runId = await store.createRun({ model: "m", promptVersion: "p", sessionCount: 1 });
    await store.saveOutcome(runId, 1, {
      windowCount: 1,
      proposedCount: 0,
      attempts: 1,
      candidates: [],
      dropped: [],
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costInr: 0 },
    });
    expect((await store.finalize(runId, async () => [])).status).toBe("finalized");
    await expect(resumeRun(store, sink().jobSink, runId)).rejects.toThrow(/start a new run/);
  });
});
