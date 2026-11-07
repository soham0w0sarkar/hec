import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { costInr } from "./prices";
import { SarvamError, backoffMs, DEFAULT_MAX_TOKENS, DEFAULT_RETRIES } from "./sarvam";
import type { ChatModel, ChatReply, ChatRequest, Usage } from "./types";

export const BEDROCK_REGION = "us-east-1";

/** A long window on a 32B model can take a couple of minutes. */
export const BEDROCK_TIMEOUT_MS = 180_000;

const RETRYABLE = new Set([
  "ThrottlingException",
  "ServiceUnavailableException",
  "InternalServerException",
  "ModelTimeoutException",
  "ModelNotReadyException",
]);

/** One Converse call. Tests pass their own, so they never touch AWS. */
export type BedrockConverse = (input: {
  modelId: string;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens: number;
  temperature: number;
}) => Promise<{ text: string; stopReason?: string; inputTokens: number; outputTokens: number }>;

export type BedrockOptions = {
  /** Bedrock model id, for example `qwen.qwen3-32b-v1:0`. */
  modelId: string;
  region?: string;
  retries?: number;
  timeoutMs?: number;
  converse?: BedrockConverse;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Chat completion through Amazon Bedrock Converse. Credentials come from the default AWS chain
 * (the `default` profile on this machine). Cost stays null: the price table is in rupees and
 * Bedrock bills in dollars, which the run does not record.
 */
export function createBedrockChat(options: BedrockOptions): ChatModel {
  if (!options.modelId.trim()) throw new Error("BEDROCK_MODEL_ID is not set");
  const retries = options.retries ?? DEFAULT_RETRIES;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const converse = options.converse ?? defaultConverse(options.region ?? BEDROCK_REGION, options.timeoutMs ?? BEDROCK_TIMEOUT_MS);

  return {
    model: options.modelId,
    async complete(request: ChatRequest): Promise<ChatReply> {
      const input = {
        modelId: options.modelId,
        system: request.system,
        messages: converseMessages(request),
        maxTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: request.temperature ?? 0.1,
      };

      let lastError: unknown = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await sleep(backoffMs(attempt));
        try {
          return toReply(await converse(input), options.modelId);
        } catch (error) {
          lastError = error;
          if (!isRetryable(error)) throw error;
        }
      }
      throw lastError;
    },
  };
}

function defaultConverse(region: string, timeoutMs: number): BedrockConverse {
  const client = new BedrockRuntimeClient({
    region,
    requestHandler: new NodeHttpHandler({ requestTimeout: timeoutMs, connectionTimeout: 10_000 }),
  });
  return async (input) => {
    const response = await client.send(
      new ConverseCommand({
        modelId: input.modelId,
        system: [{ text: input.system }],
        messages: input.messages.map(
          (message): Message => ({ role: message.role, content: [{ text: message.content }] }),
        ),
        inferenceConfig: { maxTokens: input.maxTokens, temperature: input.temperature },
      }),
    );
    const text = (response.output?.message?.content ?? [])
      .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
      .join("");
    return {
      text,
      stopReason: response.stopReason,
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
    };
  };
}

/** System is sent separately. Later turns follow the opening user message. Tool turns are not used here. */
function converseMessages(request: ChatRequest): { role: "user" | "assistant"; content: string }[] {
  const messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: request.user }];
  for (const turn of request.turns ?? []) {
    if (turn.role === "tool") throw new SarvamError(null, "tool_turn", false, "bedrock");
    messages.push({ role: turn.role, content: turn.content });
  }
  return messages;
}

function toReply(
  response: { text: string; stopReason?: string; inputTokens: number; outputTokens: number },
  modelId: string,
): ChatReply {
  if (response.stopReason === "max_tokens") throw new SarvamError(200, "length", false, "bedrock");
  if (response.stopReason === "content_filtered" || response.stopReason === "guardrail_intervened") {
    throw new SarvamError(400, "content_filter", false, "bedrock");
  }
  if (response.text.trim() === "") throw new SarvamError(200, "no_content", false, "bedrock");
  const partial = { inputTokens: response.inputTokens, outputTokens: response.outputTokens, cachedInputTokens: 0 };
  const usage: Usage = { ...partial, costInr: costInr(modelId, partial) };
  return { text: response.text, usage };
}

function isRetryable(error: unknown): boolean {
  if (error instanceof SarvamError) return error.retryable;
  return error instanceof Error && RETRYABLE.has(error.name);
}
