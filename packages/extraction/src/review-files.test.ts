import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportReview, importReview, reviewFileName, syncReviewDecision } from "./review-files";
import { memoryStore, type MemoryStore } from "./memory-store";
import { LABELS, msg, raw } from "./test-helpers";
import { runExtractSession, runFinalizeRun, type JobDeps } from "./jobs";
import { loadPrompt } from "./prompt";
import type { ChatModel } from "@hec/llm";

const sessions = {
  1: [
    msg(1, "2030-01-05 18:00", "person_1", "see you at the cafe"),
    msg(2, "2030-01-05 18:30", "person_2", "tum mere liye sab kuch ho"),
  ],
};

async function finishedRun(): Promise<{ store: MemoryStore; runId: number; dir: string }> {
  const model: ChatModel = {
    model: "fake",
    complete: async () => ({
      text: JSON.stringify({
        events: [
          raw({ evidence: [{ ref: "m1", role: "primary" }, { ref: "m2", role: "supporting" }] }),
          raw({
            category: "Saying",
            title: "A line",
            occurred_at: "2030-01-05 18:30",
            evidence: [{ ref: "m2", role: "primary" }],
            saying: { speaker: "Anita", quote: "tum mere liye sab kuch ho" },
          }),
        ],
      }),
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costInr: 0.1 },
    }),
  };
  const store = memoryStore({ labels: LABELS, sessions });
  const deps: JobDeps = {
    store,
    model,
    prompt: loadPrompt(),
    firstLookup: async () => null,
    enqueueFinalize: async () => {},
  };
  const runId = await store.createRun({ model: "fake", promptVersion: "extract.v1", sessionCount: 1 });
  await runExtractSession(deps, { runId, sessionId: 1 });
  await runFinalizeRun(deps, { runId });
  const dir = await mkdtemp(join(tmpdir(), "hec-review-"));
  return { store, runId, dir };
}

describe("exportReview and importReview", () => {
  test("exports the run's events, and refuses to overwrite without force", async () => {
    const { store, runId, dir } = await finishedRun();
    try {
      const out = await exportReview(store, { labels: LABELS, dir, now: new Date("2030-02-01T00:00:00Z") });
      expect(out.path).toBe(join(dir, reviewFileName(runId)));
      expect(out.events).toBe(2);
      const text = await readFile(out.path, "utf8");
      expect(text).toContain(`run: ${runId}`);
      expect(text).toContain("status: draft");
      expect(text).toContain("speaker: Anita");

      await expect(exportReview(store, { labels: LABELS, dir })).rejects.toThrow(/already exists/);
      await expect(exportReview(store, { labels: LABELS, dir, force: true })).resolves.toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an untouched file changes nothing", async () => {
    const { store, dir } = await finishedRun();
    try {
      const { path } = await exportReview(store, { labels: LABELS, dir });
      const outcome = await importReview(store, path, { labels: LABELS, apply: true });
      expect(outcome.plan.updates).toEqual([]);
      expect(outcome.applied).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("approving and editing are applied; the event becomes edited and its quote is kept", async () => {
    const { store, dir } = await finishedRun();
    try {
      const { path } = await exportReview(store, { labels: LABELS, dir });
      const text = (await readFile(path, "utf8"))
        .replace(/status: draft\ncategory: Meetup/, "status: approved\ncategory: Meetup")
        .replace("title: Coffee together", "title: Chai together");
      await writeFile(path, text);

      const outcome = await importReview(store, path, { labels: LABELS, apply: true });
      expect(outcome.applied).toBe(1);
      const stored = store.events.find((e) => e.category === "Meetup")!;
      expect(stored.status).toBe("edited");
      expect(stored.title).toBe("Chai together");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a dry run plans but writes nothing", async () => {
    const { store, dir } = await finishedRun();
    try {
      const { path } = await exportReview(store, { labels: LABELS, dir });
      await writeFile(path, (await readFile(path, "utf8")).replace("status: draft", "status: rejected"));
      const outcome = await importReview(store, path, { labels: LABELS, apply: false });
      expect(outcome.plan.updates).toHaveLength(1);
      expect(outcome.applied).toBe(0);
      expect(store.events.every((e) => e.status === "draft")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a bad quote is skipped and reported, and other events still apply", async () => {
    const { store, dir } = await finishedRun();
    try {
      const { path } = await exportReview(store, { labels: LABELS, dir });
      const text = (await readFile(path, "utf8"))
        .replace(/status: draft\ncategory: Saying/, "status: approved\ncategory: Saying")
        .replace("quote: tum mere liye sab kuch ho", "quote: invented words")
        .replace(/status: draft\ncategory: Meetup/, "status: approved\ncategory: Meetup");
      await writeFile(path, text);

      const outcome = await importReview(store, path, { labels: LABELS, apply: true });
      expect(outcome.plan.problems).toEqual([
        { id: expect.any(Number), problem: "quote is not word for word in an evidence message" },
      ]);
      expect(outcome.applied).toBe(1);
      expect(store.events.find((e) => e.category === "Saying")?.status).toBe("draft");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a file with a malformed block is refused entirely", async () => {
    const { store, dir } = await finishedRun();
    try {
      const { path } = await exportReview(store, { labels: LABELS, dir });
      await writeFile(path, (await readFile(path, "utf8")).replace("## event ", "## event bogus-"));
      const outcome = await importReview(store, path, { labels: LABELS, apply: true });
      expect(outcome.errors.length).toBeGreaterThan(0);
      expect(outcome.applied).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a file with no run header is refused", async () => {
    const { store, dir } = await finishedRun();
    try {
      const path = join(dir, "x.md");
      await writeFile(path, "# nothing here\n");
      await expect(importReview(store, path, { labels: LABELS, apply: true })).rejects.toThrow(/run:/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("import stores a timeline yes, and a terminal decision updates the same file", async () => {
    const { store, runId, dir } = await finishedRun();
    try {
      const { path } = await exportReview(store, { labels: LABELS, dir });
      const text = (await readFile(path, "utf8")).replace("status: draft", "status: approved").replace("timeline: no", "timeline: yes");
      await writeFile(path, text);
      const outcome = await importReview(store, path, { labels: LABELS, apply: true });
      expect(outcome.applied).toBe(1);
      const shown = (await store.runEvents(runId)).find((item) => item.status === "approved");
      expect(shown?.onTimeline).toBe(true);

      const synced = await syncReviewDecision(runId, shown!.id, "rejected", false, dir);
      expect(synced).toBe("updated");
      const file = await readFile(path, "utf8");
      expect(file).toContain(`## event ${shown!.id}\nstatus: rejected\n`);
      expect(file).toContain("timeline: no");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the export of an open run is refused", async () => {
    const store = memoryStore({ labels: LABELS, sessions });
    const runId = await store.createRun({ model: "m", promptVersion: "p", sessionCount: 1 });
    await expect(exportReview(store, { runId, labels: LABELS, dir: tmpdir() })).rejects.toThrow(/only finished/);
  });
});
