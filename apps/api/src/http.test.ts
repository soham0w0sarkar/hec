import { describe, expect, test } from "bun:test";
import type { HistoryTurn } from "@hec/agent";
import type { SQL } from "bun";
import type { ChatAnswer } from "./chat";
import { createApi } from "./http";
import type { ChatMemory } from "./memory";

function memory(): ChatMemory & { saved: HistoryTurn[] } {
  const saved: HistoryTurn[] = [];
  return {
    saved,
    async load() {
      return saved;
    },
    async append(_id, turns) {
      saved.push(...turns);
    },
  };
}

function answerOf(text: string): ChatAnswer {
  return {
    text,
    verdict: "not_found",
    confidence: "low",
    sensitivity: "none",
    interpretation: "Nothing in the search supported an answer.",
    claims: [],
    caveats: [],
    runId: "run-1",
  };
}

describe("createApi", () => {
  test("stores the turn and rejects an empty question", async () => {
    const store = memory();
    const seen: HistoryTurn[][] = [];
    const api = createApi({
      memory: store,
      sql: {} as SQL,
      answer: async (input) => {
        seen.push([...input.history]);
        return answerOf("Nothing matched the search.");
      },
    });

    const empty = await api.fetch(
      new Request("http://127.0.0.1/api/chat", {
        method: "POST",
        body: JSON.stringify({ question: "   " }),
      }),
    );
    expect(empty.status).toBe(400);

    const first = await api.fetch(
      new Request("http://127.0.0.1/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "who said hello" }),
      }),
    );
    const body = (await first.json()) as { conversationId: string; text: string };
    expect(first.status).toBe(200);
    expect(body.text).toContain("Nothing matched");
    expect(store.saved.map((turn) => turn.role)).toEqual(["user", "assistant"]);

    await api.fetch(
      new Request("http://127.0.0.1/api/chat", {
        method: "POST",
        body: JSON.stringify({ question: "and then", conversationId: body.conversationId }),
      }),
    );
    expect(seen[1]?.map((turn) => turn.content)).toContain("who said hello");
  });
});
