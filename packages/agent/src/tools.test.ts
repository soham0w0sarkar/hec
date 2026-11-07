import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import type { KeywordHit, MessageHit } from "@hec/retrieval";
import { fakeEmbedder } from "./embed";
import { createLedger } from "./ledger";
import { executeTool, type RetrievalPort, type ToolEnv } from "./tools";

const sql = {} as SQL;

function hit(over: Partial<KeywordHit> = {}): KeywordHit {
  return {
    id: 1,
    personId: "person_1",
    name: "Ravi",
    sentAt: new Date("2030-06-01T04:30:00.000Z"),
    sentAtIst: "2030-06-01 10:00:00",
    text: "hello there",
    source: "instagram",
    sourceRef: "ig:1",
    kind: "text",
    sessionId: null,
    match: "exact",
    form: "two",
    score: 1,
    ...over,
  };
}

function port(over: Partial<RetrievalPort> = {}): RetrievalPort & { calls: string[] } {
  const calls: string[] = [];
  const unused = () => {
    throw new Error("unexpected retrieval call");
  };
  const base = {
    findFirst: unused,
    findLast: unused,
    countMatches: unused,
    matchesPerPeriod: unused,
    searchMessages: unused,
    searchChunks: unused,
    hybridSearch: unused,
    getContextAround: unused,
    getDayTranscript: unused,
    busiestDays: unused,
    streaks: unused,
    whoMessagesFirst: unused,
    callCounts: unused,
    countsPerPeriod: unused,
    listEvents: unused,
  };
  const wrapped = {} as RetrievalPort;
  for (const key of Object.keys(base) as (keyof RetrievalPort)[]) {
    const fn = (over[key] ?? base[key]) as (...args: never[]) => unknown;
    (wrapped as Record<string, unknown>)[key] = (...args: never[]) => {
      calls.push(key);
      return fn(...args);
    };
  }
  return Object.assign(wrapped, { calls });
}

function env(over: Partial<ToolEnv> = {}): ToolEnv {
  return {
    sql,
    port: port(),
    embedder: null,
    chunksModel: null,
    question: "what did we say",
    ledger: createLedger(),
    timeoutMs: 1000,
    semanticError: null,
    ...over,
  };
}

const phrase = { text: "hello", mode: "phrase" as const };

describe("tool wrappers", () => {
  test("rejects a limit above the cap without calling retrieval", async () => {
    const retrieval = port();
    const outcome = await executeTool("keyword_search", { ...phrase, limit: 500 }, env({ port: retrieval }));
    expect(outcome.body).toMatchObject({ error: expect.stringContaining("invalid_input") });
    expect(retrieval.calls).toEqual([]);
  });

  test("rejects an unknown tool, extra keys, and too many variants", async () => {
    const retrieval = port();
    expect((await executeTool("drop_table", {}, env({ port: retrieval }))).body).toEqual({ error: "unknown tool" });
    expect((await executeTool("count_matches", { ...phrase, please: true }, env({ port: retrieval }))).body).toMatchObject({
      error: expect.stringContaining("invalid_input"),
    });
    const variants = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    expect((await executeTool("find_first", { ...phrase, variants }, env({ port: retrieval }))).body).toMatchObject({
      error: expect.stringContaining("variants"),
    });
    expect(retrieval.calls).toEqual([]);
  });

  test("find_first returns cited fields and the per-person and per-source checks", async () => {
    const main = hit();
    const retrieval = port({
      findFirst: async () => ({ mode: "phrase", total: 1, hit: main, runnersUp: [] }),
    });
    const ledger = createLedger();
    const outcome = await executeTool("find_first", { ...phrase, variants: ["hii"] }, env({ port: retrieval, ledger }));
    expect(retrieval.calls).toHaveLength(5);
    const body = outcome.body as { hit: MessageHit & { message_id: number; speaker: string; sent_at_utc: string } };
    expect(body.hit).toMatchObject({
      message_id: 1,
      source: "instagram",
      speaker: "Ravi",
      person_id: "person_1",
      sent_at_utc: "2030-06-01T04:30:00.000Z",
      sent_at_ist: "2030-06-01 10:00:00",
      text: "hello there",
    });
    expect(ledger.variants).toEqual(["hello", "hii"]);
    expect(ledger.messages.get(1)?.text).toBe("hello there");
    expect(ledger.looks).toHaveLength(1);
  });

  test("a thrown retrieval error does not leak its message", async () => {
    const retrieval = port({
      countMatches: async () => {
        throw new Error("hello there secret");
      },
    });
    const outcome = await executeTool("count_matches", phrase, env({ port: retrieval }));
    expect(outcome.body).toEqual({ error: "tool failed" });
    expect(JSON.stringify(outcome.body)).not.toContain("hello there");
  });

  test("a hung tool ends as a timeout", async () => {
    const retrieval = port({
      countMatches: () => new Promise(() => {}),
    });
    const outcome = await executeTool("count_matches", phrase, env({ port: retrieval, timeoutMs: 20 }));
    expect(outcome.body).toEqual({ error: "tool timed out" });
  });

  test("intimate text is kept off the tool result unless the question asked for it", async () => {
    const retrieval = port({
      searchMessages: async () => ({
        mode: "phrase" as const,
        total: 2,
        next: null,
        hits: [hit({ id: 2, text: "a nude photo" }), hit({ id: 3, text: "coffee at 10" })],
      }),
    });
    const hidden = await executeTool("keyword_search", phrase, env({ port: retrieval, question: "what did we plan" }));
    const hits = (hidden.body as { hits: { text: string }[] }).hits;
    expect(hits.map((item) => item.text)).toEqual(["coffee at 10"]);
    expect(JSON.stringify(hidden.body)).not.toContain("nude");

    const shown = await executeTool(
      "keyword_search",
      phrase,
      env({ port: retrieval, question: "show me the intimate messages" }),
    );
    expect(JSON.stringify(shown.body)).toContain("nude");
  });

  test("semantic search stays off when the embedder model is not the chunks' model", async () => {
    let embedded = 0;
    let searched = 0;
    const retrieval = port({
      searchChunks: async () => {
        searched += 1;
        return { hits: [] };
      },
    });
    const embedder = {
      model: "model-a",
      async embed(text: string) {
        embedded += 1;
        return fakeEmbedder().embed(text);
      },
    };
    const toolEnv = env({ port: retrieval, embedder, chunksModel: "model-b" });
    const first = await executeTool("semantic_search", { text: "the picnic plan" }, toolEnv);
    const second = await executeTool("semantic_search", { text: "the picnic plan" }, toolEnv);
    expect(first.body).toMatchObject({ error: expect.stringContaining("does not match") });
    expect(second.body).toMatchObject({ error: expect.stringContaining("does not match") });
    expect(embedded).toBe(0);
    expect(searched).toBe(0);
  });

  test("a matching embedder is passed through with its model name", async () => {
    let seen = "";
    const retrieval = port({
      searchChunks: async (_sql, search) => {
        seen = search.model;
        return { hits: [] };
      },
    });
    const outcome = await executeTool(
      "semantic_search",
      { text: "picnic" },
      env({ port: retrieval, embedder: fakeEmbedder("model-a"), chunksModel: "model-a" }),
    );
    expect(seen).toBe("model-a");
    expect(outcome.body).toEqual({ chunks: [] });
    const again = fakeEmbedder().embed("picnic");
    expect(await fakeEmbedder().embed("picnic")).toEqual(await again);
  });

  test("stats and events keep numbers, days, and evidence ids", async () => {
    const retrieval = port({
      callCounts: async () => ({ calls: 2, messages: 9 }),
      listEvents: async () => ({
        next: null,
        events: [
          {
            id: 4,
            title: "Argument",
            summary: "They argued.",
            category: "Conflict" as const,
            occurredAt: new Date("2030-06-03T04:00:00.000Z"),
            occurredAtIst: "2030-06-03 09:30:00",
            datePrecision: "exact_day" as const,
            endedAt: null,
            significance: 2,
            isFirst: false,
            firstOf: null,
            speakerId: null,
            quote: null,
            status: "approved" as const,
            evidenceMessageIds: [11, 12],
            evidenceTruncated: false,
          },
        ],
      }),
    });
    const ledger = createLedger();
    const counts = await executeTool("get_stats", { stat: "call_counts" }, env({ port: retrieval, ledger }));
    expect(counts.body).toMatchObject({ stat: "call_counts", result: { calls: 2, messages: 9 } });
    expect(ledger.figures.has(2)).toBe(true);
    expect(ledger.figures.has(9)).toBe(true);

    const listed = await executeTool("list_events", { category: "Conflict", limit: 5 }, env({ port: retrieval, ledger }));
    expect(listed.body).toMatchObject({
      events: [{ category: "Conflict", evidence_message_ids: [11, 12], occurred_at_ist: "2030-06-03 09:30:00" }],
    });
    expect(ledger.events[0]?.category).toBe("Conflict");
    expect(JSON.stringify(listed.body)).not.toContain("draft");
  });
});
