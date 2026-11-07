import { loadAgentPrompt, nativeActionDecoder, runAgent, type Embedder, type HistoryTurn } from "@hec/agent";
import type { AnswerPayload } from "@hec/core";
import type { ChatModel } from "@hec/llm";
import { render } from "@hec/persona";
import type { SQL } from "bun";

export type ChatAnswer = {
  text: string;
  verdict: AnswerPayload["verdict"];
  confidence: AnswerPayload["confidence"];
  sensitivity: AnswerPayload["sensitivity"];
  interpretation: string;
  claims: AnswerPayload["claims"];
  caveats: string[];
  runId: string;
};

export async function answerQuestion(
  input: { question: string; history: readonly HistoryTurn[] },
  deps: {
    sql: SQL;
    model: ChatModel;
    embedder: Embedder | null;
    chunksModel: string | null;
    persona?: "romance_geek" | "neutral";
    log?: (entry: { runId: string; ms: number; verdict: string; steps: number; toolCalls: number }) => void;
  },
): Promise<ChatAnswer> {
  const started = Date.now();
  // Native tool calls: the chat model returns empty text for search questions when asked for JSON.
  const result = await runAgent(
    { question: input.question, history: [...input.history] },
    {
      ...deps,
      decoder: nativeActionDecoder,
      prompt: loadAgentPrompt("agent.v2"),
      // Nickname-style questions need a few different searches; ₹2 cut them off mid-run.
      budget: { toolTimeoutMs: 30_000, maxCostInr: 12, maxSteps: 12, maxInputTokens: 120_000 },
    },
  );
  const spoken = await render(result.payload, deps.persona ?? "romance_geek", { model: deps.model });
  deps.log?.({
    runId: result.runId,
    ms: Date.now() - started,
    verdict: result.payload.verdict,
    steps: result.steps,
    toolCalls: result.toolCalls,
  });
  return {
    text: spoken.text,
    verdict: result.payload.verdict,
    confidence: result.payload.confidence,
    sensitivity: result.payload.sensitivity,
    interpretation: result.payload.interpretation_note,
    claims: result.payload.claims,
    caveats: [...result.payload.caveats],
    runId: result.runId,
  };
}
