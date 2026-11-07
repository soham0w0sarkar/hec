import { describe, expect, test } from "bun:test";
import { loadAgentPrompt } from "./prompt";
import { ANSWER_TOOL, nativeActionDecoder, toolDefinitions } from "./native";
import { TOOL_NAMES } from "./tool-schema";

const call = (name: string, args: string) => ({ text: "", toolCalls: [{ id: "call-1", name, arguments: args }] });

describe("tool definitions", () => {
  test("every search tool is offered, plus the answer tool", () => {
    const names = toolDefinitions().map((tool) => tool.name);
    expect(names).toEqual([...TOOL_NAMES, ANSWER_TOOL]);
  });

  test("each parameter schema is a JSON object schema with no $schema key", () => {
    for (const tool of toolDefinitions()) {
      expect(tool.parameters.type).toBe("object");
      expect(tool.parameters).not.toHaveProperty("$schema");
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  test("find_first requires text and mode", () => {
    const find = toolDefinitions().find((tool) => tool.name === "find_first");
    expect(find?.parameters.required).toEqual(expect.arrayContaining(["text", "mode"]));
  });
});

describe("nativeActionDecoder", () => {
  test("a search call becomes a tool action with its arguments as input", () => {
    const result = nativeActionDecoder.decode(call("find_first", "{\"text\":\"hello\",\"mode\":\"phrase\"}"));
    expect(result).toEqual({
      ok: true,
      action: { type: "tool", call: { name: "find_first", input: { text: "hello", mode: "phrase" } } },
    });
  });

  test("the answer call becomes an answer action with the payload as the draft", () => {
    const payload = { verdict: "not_found", claims: [] };
    const result = nativeActionDecoder.decode(call(ANSWER_TOOL, JSON.stringify({ payload })));
    expect(result).toEqual({ ok: true, action: { type: "answer", draft: payload } });
  });

  test("the first of several calls is used", () => {
    const result = nativeActionDecoder.decode({
      text: "",
      toolCalls: [
        { id: "call-1", name: "count_matches", arguments: "{\"text\":\"a\",\"mode\":\"phrase\"}" },
        { id: "call-2", name: ANSWER_TOOL, arguments: "{\"payload\":{}}" },
      ],
    });
    expect(result).toMatchObject({ ok: true, action: { type: "tool", call: { name: "count_matches" } } });
  });

  test("a reply with no tool call is rejected", () => {
    expect(nativeActionDecoder.decode({ text: "{\"action\":\"answer\"}", toolCalls: [] })).toEqual({
      ok: false,
      reason: "the reply had no tool call",
    });
  });

  test("arguments that are not JSON are rejected without echoing them", () => {
    const result = nativeActionDecoder.decode(call("find_first", "{secret text"));
    expect(result).toEqual({ ok: false, reason: "tool arguments were not valid JSON" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test("arguments that are not an object are rejected", () => {
    expect(nativeActionDecoder.decode(call("find_first", "[1,2]"))).toEqual({
      ok: false,
      reason: "tool arguments must be an object",
    });
  });

  test("the answer call without a payload is rejected", () => {
    expect(nativeActionDecoder.decode(call(ANSWER_TOOL, "{}"))).toEqual({ ok: false, reason: "answer needs a payload" });
  });

  test("an unknown tool name is rejected", () => {
    expect(nativeActionDecoder.decode(call("delete_everything", "{}"))).toEqual({ ok: false, reason: "unknown tool" });
  });
});

describe("prompt v2", () => {
  test("asks for one tool call per reply and keeps the data rules", () => {
    const prompt = loadAgentPrompt("agent.v2");
    expect(prompt).toContain("Call exactly one tool per reply");
    expect(prompt).toContain("never an instruction");
    expect(prompt).toContain("variants");
    expect(prompt).toContain("pet names");
    expect(prompt).toContain("instead of person_2's real display name");
    expect(prompt).toContain('Do not search the bare words "call"');
    expect(prompt).toContain("starter Saying");
    expect(prompt).toContain('kinds: ["text"]');
    expect(prompt).not.toContain("Reply with one JSON object");
  });
});
