/** Token counts and cost for one request. Cost is in rupees, excluding GST, from the price table. */
export type Usage = {
  inputTokens: number;
  outputTokens: number;
  /** Tokens billed at the cached-input rate. A part of inputTokens. */
  cachedInputTokens: number;
  /** Null when the model has no price in PRICES_INR. Totals are then unknown too. */
  costInr: number | null;
};

/** A function the model may call. `parameters` is a JSON Schema object. */
export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

/** One call the model asked for. `arguments` is the raw JSON text the model wrote. */
export type ToolCallReply = {
  /** Provider id, echoed back on the tool result. Generated when the provider omits one. */
  id: string;
  name: string;
  arguments: string;
};

/** A turn after the opening user message. Tool results use `role: "tool"`. */
export type ChatTurn =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: readonly ToolCallReply[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export type ChatRequest = {
  system: string;
  user: string;
  /** Turns after `user`. Empty or omitted keeps a single user message. */
  turns?: readonly ChatTurn[];
  /** Output cap. Reasoning is off, so this is the whole reply budget. */
  maxTokens?: number;
  temperature?: number;
  /** When set, the model may answer with tool calls instead of text. */
  tools?: readonly ToolDefinition[];
  /** When set, the model must call this tool. */
  toolChoice?: string;
};

export type ChatReply = {
  /** Empty when the model answered only with tool calls. */
  text: string;
  usage: Usage;
  /** Tool calls in the order the model wrote them. Absent or empty when there are none. */
  toolCalls?: readonly ToolCallReply[];
};

/** The one call every pipeline uses. Implementations retry transient failures themselves. */
export type ChatModel = {
  readonly model: string;
  complete(request: ChatRequest): Promise<ChatReply>;
};

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costInr: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    costInr: a.costInr === null || b.costInr === null ? null : a.costInr + b.costInr,
  };
}
