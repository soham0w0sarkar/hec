import { costInr } from "./prices";
import type { ChatModel, ChatReply, ChatRequest, ChatTurn, ToolCallReply, Usage } from "./types";

export const SARVAM_BASE_URL = "https://api.sarvam.ai";
export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_RETRIES = 3;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type SarvamOptions = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Extra attempts after the first for network errors, 429 and 5xx. */
  retries?: number;
  timeoutMs?: number;
  fetch?: FetchLike;
  /** Waits between attempts. Replaceable so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * A failed call. The message carries status and the provider's error code, never the prompt.
 * The name stays `SarvamError` for every provider: callers classify failures by name, and the
 * provider label in the message says which backend failed.
 */
export class SarvamError extends Error {
  constructor(
    readonly status: number | null,
    readonly code: string | null,
    readonly retryable: boolean,
    readonly provider: string = "sarvam",
  ) {
    super(`${provider} request failed${status ? ` with HTTP ${status}` : ""}${code ? ` (${code})` : ""}`);
    this.name = "SarvamError";
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

/**
 * Chat completion over Sarvam's v1 endpoint. Reasoning is switched off (`reasoning_effort: null`),
 * because thinking tokens count against max_tokens and would otherwise eat the reply. The
 * extraction prompt asks for JSON and the caller validates it.
 */
export function createSarvamChat(options: SarvamOptions): ChatModel {
  if (!options.apiKey.trim()) throw new Error("SARVAM_API_KEY is not set");
  return createCompletionsChat({
    provider: "sarvam",
    baseUrl: options.baseUrl ?? SARVAM_BASE_URL,
    headers: { "api-subscription-key": options.apiKey },
    model: options.model,
    extraBody: { reasoning_effort: null },
    retries: options.retries,
    timeoutMs: options.timeoutMs,
    fetch: options.fetch,
    sleep: options.sleep,
  });
}

/** Any server that speaks the OpenAI chat completions shape: Sarvam, or a local Ollama server. */
export type CompletionsOptions = {
  /** Names the backend in error messages. */
  provider: string;
  baseUrl: string;
  headers: Record<string, string>;
  model: string;
  /** Extra fields for the request body, for backends that need them. */
  extraBody?: Record<string, unknown>;
  retries?: number;
  timeoutMs?: number;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
};

export function createCompletionsChat(options: CompletionsOptions): ChatModel {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const retries = options.retries ?? DEFAULT_RETRIES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  return {
    model: options.model,
    async complete(request: ChatRequest): Promise<ChatReply> {
      const body = JSON.stringify({
        ...(options.extraBody ?? {}),
        model: options.model,
        messages: wireMessages(request),
        temperature: request.temperature ?? 0.1,
        max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(request.tools && request.tools.length > 0
          ? { tools: request.tools.map((tool) => ({ type: "function", function: tool })) }
          : {}),
        ...(request.toolChoice ? { tool_choice: { type: "function", function: { name: request.toolChoice } } } : {}),
      });

      let lastError: unknown = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) await sleep(backoffMs(attempt));
        try {
          const json = await send(doFetch, `${baseUrl}/v1/chat/completions`, options.headers, body, timeoutMs, options.provider);
          return parseReply(json, options.model);
        } catch (error) {
          lastError = error;
          if (!(error instanceof SarvamError ? error.retryable : isNetworkError(error))) throw error;
        }
      }
      throw lastError;
    },
  };
}

async function send(
  doFetch: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
  provider: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new NetworkError(provider, error);
  }

  if (!response.ok) {
    const code = await errorCode(response);
    throw new SarvamError(response.status, code, RETRYABLE_STATUS.has(response.status), provider);
  }
  return response.json();
}

class NetworkError extends Error {
  constructor(provider: string, cause: unknown) {
    super(`${provider} request did not complete (network or timeout)`, { cause });
    this.name = "NetworkError";
  }
}

function isNetworkError(error: unknown): boolean {
  return error instanceof NetworkError;
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const json = (await response.json()) as { error?: { code?: unknown } };
    const code = json?.error?.code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** (attempt - 1));
}

type Completion = {
  choices?: { message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }[];
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown } | null;
  };
};

/** Reads the reply and the usage. A reply cut off by the length cap is an error, not a truncated answer. */
export function parseReply(json: unknown, model: string): ChatReply {
  const completion = json as Completion;
  const choice = completion?.choices?.[0];
  const text = choice?.message?.content;
  const toolCalls = readToolCalls(choice?.message?.tool_calls);
  if (typeof text !== "string" && toolCalls.length === 0) throw new SarvamError(200, "no_content", false);
  if (choice?.finish_reason === "length") throw new SarvamError(200, "length", false);

  const inputTokens = count(completion.usage?.prompt_tokens);
  const outputTokens = count(completion.usage?.completion_tokens);
  const cachedInputTokens = count(completion.usage?.prompt_tokens_details?.cached_tokens);
  const partial = { inputTokens, outputTokens, cachedInputTokens };
  const usage: Usage = { ...partial, costInr: costInr(model, partial) };
  return { text: typeof text === "string" ? text : "", usage, toolCalls };
}

function readToolCalls(value: unknown): ToolCallReply[] {
  if (!Array.isArray(value)) return [];
  const calls: ToolCallReply[] = [];
  for (const call of value) {
    const raw = call as { id?: unknown; function?: { name?: unknown; arguments?: unknown } } | null;
    const fn = raw?.function;
    if (typeof fn?.name !== "string") continue;
    const args = fn.arguments;
    const id = typeof raw?.id === "string" && raw.id.length > 0 ? raw.id : `call-${calls.length + 1}`;
    calls.push({ id, name: fn.name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) });
  }
  return calls;
}

/** System, the opening user message, then any later turns. Tool results keep their call id. */
export function wireMessages(request: ChatRequest): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [
    { role: "system", content: request.system },
    { role: "user", content: request.user },
  ];
  for (const turn of request.turns ?? []) messages.push(wireTurn(turn));
  return messages;
}

function wireTurn(turn: ChatTurn): Record<string, unknown> {
  if (turn.role === "tool") return { role: "tool", tool_call_id: turn.toolCallId, name: turn.name, content: turn.content };
  if (turn.role === "user") return { role: "user", content: turn.content };
  if (!turn.toolCalls || turn.toolCalls.length === 0) return { role: "assistant", content: turn.content };
  return {
    role: "assistant",
    content: turn.content === "" ? null : turn.content,
    tool_calls: turn.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    })),
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}
