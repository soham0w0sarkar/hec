import { describe, expect, test } from "bun:test";
import { ZERO_USAGE, type ChatModel } from "@hec/llm";
import type { SQL } from "bun";
import { answerQuestion } from "./chat";

const payload = {
  version: 1,
  question_type: "other",
  verdict: "not_found",
  interpretation_note: "Nothing matched.",
  claims: [],
  searched: { tools: [], variants: [], date_ranges: [] },
  caveats: [],
  confidence: "low",
  sensitivity: "none",
};

describe("answerQuestion", () => {
  test("returns the plain rendering and does not log the question", async () => {
    const seen: string[] = [];
    const model: ChatModel = {
      model: "test",
      async complete(request) {
        seen.push(request.user);
        return {
          text: "",
          usage: ZERO_USAGE,
          toolCalls: [{ id: "call-1", name: "answer", arguments: JSON.stringify({ payload }) }],
        };
      },
    };
    const logs: string[] = [];
    const answer = await answerQuestion(
      { question: "where is the spare key", history: [] },
      {
        sql: {} as SQL,
        model,
        embedder: null,
        chunksModel: null,
        persona: "neutral",
        log: (entry) => logs.push(`${entry.verdict} ${entry.runId}`),
      },
    );
    expect(answer.verdict).toBe("not_found");
    expect(answer.text).toContain("Nothing matched the search.");
    expect(answer.text).not.toContain("spare key");
    expect(logs[0]).toContain("not_found");
    expect(seen[0]).toContain("where is the spare key");
  });
});
