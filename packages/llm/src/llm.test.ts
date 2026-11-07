import { describe, expect, test } from "bun:test";
import { costInr } from "./prices";
import { SarvamError, backoffMs, createSarvamChat, parseReply, type FetchLike } from "./sarvam";

// Each factory builds a fresh Response, because a body can only be read once.
type Step = () => Response | Error;

const ok = (content: string, usage = { prompt_tokens: 1000, completion_tokens: 100 }): Step => () =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const fail = (status: number, code: string): Step => () =>
  new Response(JSON.stringify({ error: { message: "secret prompt text", code } }), { status });

const drop = (error: Error): Step => () => error;

function scripted(steps: Step[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let next = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const item = (steps[Math.min(next++, steps.length - 1)] as Step)();
    if (item instanceof Error) throw item;
    return item;
  };
  return { fetch, calls };
}

const noSleep = async () => {};

describe("costInr", () => {
  test("prices input, cached input and output in rupees per million", () => {
    // 1,000,000 uncached input at 15, 0 cached, 1,000,000 output at 60 = 75 rupees.
    expect(costInr("sarvam-105b", { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 0 })).toBe(75);
  });

  test("cached tokens are part of the input and billed at the cached rate", () => {
    // 400k cached at 5 plus 600k uncached at 15 = 2 + 9 = 11 rupees.
    expect(costInr("sarvam-105b", { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 400_000 })).toBe(11);
  });

  test("an unknown model has no cost, not a guessed one", () => {
    expect(costInr("some-other-model", { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 })).toBeNull();
  });
});

describe("parseReply", () => {
  test("reads text and usage", () => {
    const reply = parseReply(
      { choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
      "sarvam-105b",
    );
    expect(reply.text).toBe("{}");
    expect(reply.usage).toEqual({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, costInr: expect.any(Number) });
  });

  test("a reply cut off by the length cap is an error", () => {
    expect(() =>
      parseReply({ choices: [{ message: { content: "{\"events\":[" }, finish_reason: "length" }], usage: {} }, "sarvam-105b"),
    ).toThrow(SarvamError);
  });

  test("a reply without content is an error", () => {
    expect(() => parseReply({ choices: [{ message: { content: null } }] }, "sarvam-105b")).toThrow(SarvamError);
  });

  test("a reply with tool calls and no text is read, with the arguments as written", () => {
    const reply = parseReply(
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: "call-a", type: "function", function: { name: "find_first", arguments: "{\"text\":\"hi\",\"mode\":\"phrase\"}" } },
                { type: "function", function: { name: "count_matches", arguments: { text: "hi", mode: "any_word" } } },
                { type: "function", function: { arguments: "{}" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: {},
      },
      "sarvam-105b",
    );
    expect(reply.text).toBe("");
    expect(reply.toolCalls).toEqual([
      { id: "call-a", name: "find_first", arguments: "{\"text\":\"hi\",\"mode\":\"phrase\"}" },
      { id: "call-2", name: "count_matches", arguments: "{\"text\":\"hi\",\"mode\":\"any_word\"}" },
    ]);
  });
});

describe("createSarvamChat", () => {
  test("sends the key in the header, reasoning off, and the two messages", async () => {
    const { fetch, calls } = scripted([ok("{\"events\":[]}")]);
    const chat = createSarvamChat({ apiKey: "k-123", model: "sarvam-105b", fetch, sleep: noSleep });
    await chat.complete({ system: "sys", user: "usr", maxTokens: 500 });

    expect(calls[0]?.url).toBe("https://api.sarvam.ai/v1/chat/completions");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["api-subscription-key"]).toBe("k-123");
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body.model).toBe("sarvam-105b");
    expect(body.reasoning_effort).toBeNull();
    expect(body.max_tokens).toBe(500);
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "usr" },
    ]);
  });

  test("sends tool definitions as functions only when given", async () => {
    const { fetch, calls } = scripted([ok("{}"), ok("{}")]);
    const chat = createSarvamChat({ apiKey: "k", model: "sarvam-105b", fetch, sleep: noSleep });
    const parameters = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
    await chat.complete({ system: "s", user: "u", tools: [{ name: "find_first", description: "earliest", parameters }] });
    await chat.complete({ system: "s", user: "u" });
    expect(JSON.parse(calls[0]?.init.body as string).tools).toEqual([
      { type: "function", function: { name: "find_first", description: "earliest", parameters } },
    ]);
    expect(JSON.parse(calls[1]?.init.body as string)).not.toHaveProperty("tools");
  });

  test("sends tool results as tool messages tied to the call id", async () => {
    const { fetch, calls } = scripted([ok("{}")]);
    const chat = createSarvamChat({ apiKey: "k", model: "sarvam-105b", fetch, sleep: noSleep });
    const call = { id: "call-a", name: "find_first", arguments: "{\"text\":\"hi\"}" };
    await chat.complete({
      system: "s",
      user: "u",
      turns: [
        { role: "assistant", content: "", toolCalls: [call] },
        { role: "tool", toolCallId: "call-a", name: "find_first", content: "found 1" },
      ],
    });
    expect(JSON.parse(calls[0]?.init.body as string).messages).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "u" },
      { role: "assistant", content: null, tool_calls: [{ id: "call-a", type: "function", function: { name: "find_first", arguments: "{\"text\":\"hi\"}" } }] },
      { role: "tool", tool_call_id: "call-a", name: "find_first", content: "found 1" },
    ]);
    expect(JSON.parse(calls[0]?.init.body as string)).not.toHaveProperty("tool_choice");
  });

  test("can require one named tool", async () => {
    const { fetch, calls } = scripted([ok("{}")]);
    const chat = createSarvamChat({ apiKey: "k", model: "sarvam-105b", fetch, sleep: noSleep });
    await chat.complete({ system: "s", user: "u", toolChoice: "answer" });
    expect(JSON.parse(calls[0]?.init.body as string).tool_choice).toEqual({ type: "function", function: { name: "answer" } });
  });

  test("retries 429 and 5xx, then succeeds", async () => {
    const waits: number[] = [];
    const { fetch, calls } = scripted([fail(429, "rate_limit"), fail(503, "unavailable"), ok("done")]);
    const chat = createSarvamChat({ apiKey: "k", model: "sarvam-105b", fetch, sleep: async (ms) => void waits.push(ms) });
    const reply = await chat.complete({ system: "s", user: "u" });
    expect(reply.text).toBe("done");
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([1000, 2000]);
  });

  test("does not retry a bad request or a bad key or no credit", async () => {
    for (const status of [400, 401, 402]) {
      const { fetch, calls } = scripted([fail(status, "x")]);
      const chat = createSarvamChat({ apiKey: "k", model: "sarvam-105b", fetch, sleep: noSleep });
      await expect(chat.complete({ system: "s", user: "u" })).rejects.toBeInstanceOf(SarvamError);
      expect(calls).toHaveLength(1);
    }
  });

  test("gives up after the retry budget and keeps the code, not the body", async () => {
    const { fetch, calls } = scripted([fail(500, "boom")]);
    const chat = createSarvamChat({ apiKey: "k", model: "sarvam-105b", fetch, retries: 2, sleep: noSleep });
    const error = await chat.complete({ system: "s", user: "u" }).catch((e: unknown) => e);
    expect(calls).toHaveLength(3);
    expect(error).toBeInstanceOf(SarvamError);
    expect((error as SarvamError).message).toContain("boom");
    expect((error as SarvamError).message).not.toContain("secret prompt text");
  });

  test("network errors are retried", async () => {
    const { fetch, calls } = scripted([drop(new TypeError("socket closed")), ok("fine")]);
    const chat = createSarvamChat({ apiKey: "k", model: "sarvam-105b", fetch, sleep: noSleep });
    expect((await chat.complete({ system: "s", user: "u" })).text).toBe("fine");
    expect(calls).toHaveLength(2);
  });

  test("an empty key is refused before any call", () => {
    expect(() => createSarvamChat({ apiKey: "  ", model: "sarvam-105b" })).toThrow(/SARVAM_API_KEY/);
  });

  test("backoff doubles and is capped", () => {
    expect([1, 2, 3].map(backoffMs)).toEqual([1000, 2000, 4000]);
    expect(backoffMs(20)).toBe(30_000);
  });
});
