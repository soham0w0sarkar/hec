import { describe, expect, test } from "bun:test";
import { createLocalChat } from "./local";
import { SarvamError, type FetchLike } from "./sarvam";

const noSleep = async () => {};

function fixedFetch(...responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let next = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return responses[Math.min(next++, responses.length - 1)]!.clone() as Awaited<ReturnType<FetchLike>>;
  };
  return { fetch, calls };
}

const reply = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } }), {
    status: 200,
  });

describe("createLocalChat", () => {
  test("posts to the local server with no key and no reasoning field, and reads the reply", async () => {
    const { fetch, calls } = fixedFetch(reply("{}"));
    const chat = createLocalChat({ model: "qwen2.5:7b-instruct", fetch, sleep: noSleep });
    const result = await chat.complete({ system: "s", user: "u" });

    expect(calls[0]?.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["api-subscription-key"]).toBeUndefined();
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.model).toBe("qwen2.5:7b-instruct");
    expect(body.messages[0]).toEqual({ role: "system", content: "s" });
    expect(result.text).toBe("{}");
    expect(result.usage.costInr).toBeNull();
  });

  test("a failure names the local provider, so logs say which backend broke", async () => {
    const { fetch } = fixedFetch(new Response(JSON.stringify({ error: { message: "x" } }), { status: 400 }));
    const chat = createLocalChat({ model: "m", fetch, sleep: noSleep });
    const error = await chat.complete({ system: "s", user: "u" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SarvamError);
    expect((error as SarvamError).message).toBe("local request failed with HTTP 400");
    expect((error as SarvamError).provider).toBe("local");
  });

  test("a reply cut off at the length cap is an error", async () => {
    const cut = new Response(JSON.stringify({ choices: [{ message: { content: "{" }, finish_reason: "length" }], usage: {} }), { status: 200 });
    const chat = createLocalChat({ model: "m", fetch: fixedFetch(cut).fetch, sleep: noSleep });
    await expect(chat.complete({ system: "s", user: "u" })).rejects.toMatchObject({ code: "length" });
  });

  test("an empty model name is refused", () => {
    expect(() => createLocalChat({ model: "  " })).toThrow(/LOCAL_LLM_MODEL/);
  });
});
