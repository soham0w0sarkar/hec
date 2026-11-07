import { describe, expect, test } from "bun:test";
import { createBedrockChat, type BedrockConverse } from "./bedrock";
import { SarvamError } from "./sarvam";

const noSleep = async () => {};

function scripted(response: Awaited<ReturnType<BedrockConverse>> | Error): { converse: BedrockConverse; calls: number } {
  const state = { calls: 0 };
  const converse: BedrockConverse = async () => {
    state.calls += 1;
    if (response instanceof Error) throw response;
    return response;
  };
  return { get calls() { return state.calls; }, converse };
}

const ok = { text: "{}", stopReason: "end_turn", inputTokens: 20, outputTokens: 4 };

describe("createBedrockChat", () => {
  test("reads the reply and records no rupee cost", async () => {
    const fake = scripted(ok);
    const chat = createBedrockChat({ modelId: "qwen.qwen3-32b-v1:0", converse: fake.converse, sleep: noSleep });
    const reply = await chat.complete({ system: "s", user: "u" });
    expect(reply.text).toBe("{}");
    expect(reply.usage.inputTokens).toBe(20);
    expect(reply.usage.costInr).toBeNull();
    expect(fake.calls).toBe(1);
  });

  test("a reply cut off at the length cap is an error and is not retried", async () => {
    const fake = scripted({ ...ok, stopReason: "max_tokens", text: "{" });
    const chat = createBedrockChat({ modelId: "m", converse: fake.converse, sleep: noSleep });
    await expect(chat.complete({ system: "s", user: "u" })).rejects.toMatchObject({ code: "length", provider: "bedrock" });
    expect(fake.calls).toBe(1);
  });

  test("a content filter refusal names bedrock", async () => {
    const fake = scripted({ ...ok, stopReason: "guardrail_intervened", text: "" });
    const chat = createBedrockChat({ modelId: "m", converse: fake.converse, sleep: noSleep });
    const error = await chat.complete({ system: "s", user: "u" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SarvamError);
    expect((error as SarvamError).message).toBe("bedrock request failed with HTTP 400 (content_filter)");
  });

  test("throttling is retried, then the reply is returned", async () => {
    let calls = 0;
    const converse: BedrockConverse = async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("slow down"), { name: "ThrottlingException" });
      return ok;
    };
    const chat = createBedrockChat({ modelId: "m", converse, retries: 2, sleep: noSleep });
    expect((await chat.complete({ system: "s", user: "u" })).text).toBe("{}");
    expect(calls).toBe(2);
  });

  test("an empty model id is refused", () => {
    expect(() => createBedrockChat({ modelId: "  " })).toThrow(/BEDROCK_MODEL_ID/);
  });
});
