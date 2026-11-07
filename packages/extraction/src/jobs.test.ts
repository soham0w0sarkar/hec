import { describe, expect, test } from "bun:test";
import type { ChatModel, ChatRequest } from "@hec/llm";
import { SarvamError } from "@hec/llm";
import { runExtractSession, runFinalizeRun, type JobDeps } from "./jobs";
import { loadPrompt } from "./prompt";
import { memoryStore, type MemoryStore } from "./memory-store";
import { LABELS, msg, raw } from "./test-helpers";
import { describeFailure } from "./store";

const session1 = [
  msg(1, "2030-01-05 18:00", "person_1", "see you at the cafe"),
  msg(2, "2030-01-05 18:30", "person_2", "reached!"),
];
const session2 = [msg(11, "2030-02-01 10:00", "person_1", "good morning")];

/** Returns a Meetup for any window that cites m1, and nothing otherwise. */
function modelThatFindsSession1(): ChatModel {
  return {
    model: "fake",
    async complete(request: ChatRequest) {
      const events = request.user.includes("[m1]")
        ? [raw({ evidence: [{ ref: "m1", role: "primary" }, { ref: "m2", role: "supporting" }] })]
        : [];
      return { text: JSON.stringify({ events }), usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, costInr: 0.5 } };
    },
  };
}

function setup(model: ChatModel = modelThatFindsSession1()) {
  const store: MemoryStore = memoryStore({
    labels: LABELS,
    sessions: { 1: session1, 2: session2 },
  });
  const enqueued: number[] = [];
  const logs: string[] = [];
  const deps: JobDeps = {
    store,
    model,
    prompt: loadPrompt(),
    firstLookup: async () => null,
    enqueueFinalize: async (runId) => {
      enqueued.push(runId);
    },
    log: (line) => logs.push(line),
  };
  return { store, deps, enqueued, logs };
}

async function openRun(store: MemoryStore, sessionCount = 2): Promise<number> {
  return store.createRun({ model: "fake", promptVersion: "extract.v1", sessionCount });
}

describe("runExtractSession", () => {
  test("saves the session and queues finalize only after the last session", async () => {
    const { store, deps, enqueued } = setup();
    const runId = await openRun(store);

    expect(await runExtractSession(deps, { runId, sessionId: 1 })).toBe("saved");
    expect(enqueued).toEqual([]);

    expect(await runExtractSession(deps, { runId, sessionId: 2 })).toBe("saved");
    expect(enqueued).toEqual([runId]);
  });

  test("a session with no events is a normal, saved outcome", async () => {
    const { store, deps } = setup();
    const runId = await openRun(store);
    expect(await runExtractSession(deps, { runId, sessionId: 2 })).toBe("saved");
    const states = await store.sessionStates(runId);
    expect(states.get(2)).toBe("succeeded");
  });

  test("skips when the run is already finalized", async () => {
    const { store, deps, logs } = setup();
    const runId = await openRun(store, 1);
    await runExtractSession(deps, { runId, sessionId: 1 });
    await runFinalizeRun(deps, { runId });

    expect(await runExtractSession(deps, { runId, sessionId: 2 })).toBe("skipped");
    expect(logs.some((line) => line.includes("succeeded"))).toBe(true);
  });

  test("a session that no longer exists is recorded as failed and not retried silently", async () => {
    const { store, deps } = setup();
    const runId = await openRun(store, 1);
    expect(await runExtractSession(deps, { runId, sessionId: 999 })).toBe("failed");
    expect(store.failures[0]?.message).toContain("no longer exists");
  });

  test("a model failure is recorded with the code only, and the job still fails", async () => {
    const failing: ChatModel = {
      model: "fake",
      complete: async () => {
        throw new SarvamError(500, "boom", false);
      },
    };
    const { store, deps } = setup(failing);
    const runId = await openRun(store, 1);
    await expect(runExtractSession(deps, { runId, sessionId: 1 })).rejects.toBeInstanceOf(SarvamError);
    expect(store.failures).toHaveLength(1);
    expect(store.failures[0]?.message).toContain("HTTP 500");
    expect(store.results.get(`${runId}:1`)?.status).toBe("failed");
  });

  test("a failed session blocks finalize until it is re-run", async () => {
    let calls = 0;
    const flaky: ChatModel = {
      model: "fake",
      complete: async (request) => {
        calls++;
        if (calls === 1) throw new SarvamError(503, "unavailable", false);
        return modelThatFindsSession1().complete(request);
      },
    };
    const { store, deps, enqueued } = setup(flaky);
    const runId = await openRun(store);
    await expect(runExtractSession(deps, { runId, sessionId: 1 })).rejects.toThrow();
    await runExtractSession(deps, { runId, sessionId: 2 });
    expect(enqueued).toEqual([]);

    await runExtractSession(deps, { runId, sessionId: 1 });
    expect(enqueued).toEqual([runId]);
  });

  test("a worker with a different model or prompt refuses the run, and writes nothing", async () => {
    const { store, deps } = setup();
    const runId = await store.createRun({ model: "some-other-model", promptVersion: "extract.v1", sessionCount: 2 });
    await expect(runExtractSession(deps, { runId, sessionId: 1 })).rejects.toThrow(/was started with model/);
    expect(store.results.has(`${runId}:1`)).toBe(false);
  });

  test("a run that does not exist is an error, not a silent skip", async () => {
    const { deps } = setup();
    await expect(runExtractSession(deps, { runId: 404, sessionId: 1 })).rejects.toThrow(/does not exist/);
  });
});

describe("runFinalizeRun", () => {
  test("writes draft events with evidence, and a second finalize is a no-op", async () => {
    const { store, deps } = setup();
    const runId = await openRun(store);
    await runExtractSession(deps, { runId, sessionId: 1 });
    await runExtractSession(deps, { runId, sessionId: 2 });

    const first = await runFinalizeRun(deps, { runId });
    expect(first).toEqual({ status: "finalized", events: 1 });
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({ status: "draft", category: "Meetup", runId });
    expect(store.events[0]?.evidence.map((e) => e.messageId)).toEqual([1, 2]);

    const second = await runFinalizeRun(deps, { runId });
    expect(second.status).toBe("skipped");
    expect(store.events).toHaveLength(1);
  });

  test("finalize refuses while a session is not done", async () => {
    const { store, deps } = setup();
    const runId = await openRun(store);
    await runExtractSession(deps, { runId, sessionId: 1 });
    const result = await runFinalizeRun(deps, { runId });
    expect(result).toEqual({ status: "skipped", reason: "1 of 2 sessions are done" });
    expect(store.runs.get(runId)?.status).toBe("running");
  });

  test("a second run never mixes its drafts with the first", async () => {
    const { store, deps } = setup();
    const first = await openRun(store, 1);
    await runExtractSession(deps, { runId: first, sessionId: 1 });
    await runFinalizeRun(deps, { runId: first });

    const second = await openRun(store, 1);
    await runExtractSession(deps, { runId: second, sessionId: 1 });
    await runFinalizeRun(deps, { runId: second });

    expect(store.events.map((e) => e.runId)).toEqual([first, second]);
  });
});

describe("describeFailure", () => {
  test("keeps the provider and validation summaries, and nothing from a message", () => {
    expect(describeFailure(new SarvamError(429, "rate_limit", true))).toBe("sarvam request failed with HTTP 429 (rate_limit)");
    expect(describeFailure(new Error("secret message text"))).toBe("unexpected Error");
    expect(describeFailure("a string")).toBe("unexpected error");
  });
});
