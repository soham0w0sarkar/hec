import { createCompletionsChat, DEFAULT_RETRIES, type FetchLike } from "./sarvam";
import type { ChatModel } from "./types";

/** Ollama's default address. Its OpenAI-compatible API is under /v1. */
export const LOCAL_BASE_URL = "http://127.0.0.1:11434";

/** A 7B model on a laptop can take minutes for one long window, so the default is generous. */
export const LOCAL_TIMEOUT_MS = 900_000;

export type LocalOptions = {
  /** The model name the local server knows, e.g. `qwen2.5:7b-instruct`. */
  model: string;
  baseUrl?: string;
  retries?: number;
  timeoutMs?: number;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Chat completion against a local server (Ollama). No key and no price: the cost is zero in
 * money, so usage carries null cost and nothing is billed. Reply handling is the same as Sarvam's.
 */
export function createLocalChat(options: LocalOptions): ChatModel {
  if (!options.model.trim()) throw new Error("LOCAL_LLM_MODEL is not set");
  return createCompletionsChat({
    provider: "local",
    baseUrl: options.baseUrl ?? LOCAL_BASE_URL,
    headers: {},
    model: options.model,
    retries: options.retries ?? DEFAULT_RETRIES,
    timeoutMs: options.timeoutMs ?? LOCAL_TIMEOUT_MS,
    fetch: options.fetch,
    sleep: options.sleep,
  });
}
