import { z } from "zod";
import type { ToolDefinition } from "@hec/llm";
import type { ActionDecoder, DecodeResult, ModelReply } from "./protocol";
import { TOOL_NAMES, isToolName, toolSchemas, type ToolName } from "./tool-schema";

/** The tool the model calls to finish. Its `payload` is the answer object. */
export const ANSWER_TOOL = "answer";

const DESCRIPTIONS: Record<ToolName, string> = {
  find_first: "Earliest message that matches the text. Put spelling variants in one call.",
  find_last: "Latest message that matches the text. Put spelling variants in one call.",
  count_matches: "Total number of messages that match the text.",
  matches_per_period: "Matches counted per day, week, or month.",
  keyword_search: "Messages that match the text, up to a limit.",
  semantic_search: "Meaning search over conversation chunks. If it says it is off, use keyword_search.",
  hybrid_search: "Keyword and meaning search together. Same off rule as semantic_search.",
  get_context_around: "Messages before and after one message id.",
  get_day_transcript: "Messages on one India-time day, oldest first.",
  get_stats: "Counts and streaks: busiest_days, streaks, who_messages_first, call_counts, counts_per_period.",
  list_events: "Reviewed events only, with their evidence message ids.",
};

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

/** One definition per search tool, built from the same zod schemas that check the arguments. */
export function toolDefinitions(): ToolDefinition[] {
  const searches = TOOL_NAMES.map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    parameters: jsonSchema(toolSchemas[name]),
  }));
  return [
    ...searches,
    {
      name: ANSWER_TOOL,
      description: "Give the final answer. payload is the answer object from the instructions. Call this when you are done searching.",
      parameters: {
        type: "object",
        properties: { payload: { type: "object" } },
        required: ["payload"],
        additionalProperties: false,
      },
    },
  ];
}

const TOOLS = toolDefinitions();
const ArgumentsSchema = z.record(z.string(), z.unknown());

/**
 * Reads native tool calls. The model is given every search tool and an `answer` tool, and must call
 * exactly one of them per reply. If it writes several, the first one is used; the loop asks again after it.
 * Arguments are checked here only for shape. Each search tool still checks its own schema.
 */
export const nativeActionDecoder: ActionDecoder = {
  tools: TOOLS,
  retryHint: "Call exactly one tool. Call answer when you are done searching.",
  decode(reply: ModelReply): DecodeResult {
    const call = reply.toolCalls[0];
    if (!call) return { ok: false, reason: "the reply had no tool call" };

    let raw: unknown;
    try {
      raw = JSON.parse(call.arguments);
    } catch {
      return { ok: false, reason: "tool arguments were not valid JSON" };
    }
    const args = ArgumentsSchema.safeParse(raw);
    if (!args.success) return { ok: false, reason: "tool arguments must be an object" };

    if (call.name === ANSWER_TOOL) {
      if (!("payload" in args.data)) return { ok: false, reason: "answer needs a payload" };
      return { ok: true, action: { type: "answer", draft: args.data.payload } };
    }
    if (!isToolName(call.name)) return { ok: false, reason: "unknown tool" };
    return { ok: true, action: { type: "tool", call: { name: call.name, input: args.data } } };
  },
};
