import { describe, expect, test } from "bun:test";
import { SarvamError, type ChatModel, type ChatRequest } from "@hec/llm";
import { InvalidReplyError, extractSession, extractWindow } from "./extract";
import { loadPrompt } from "./prompt";
import { buildWindows } from "./transcript";
import { LABELS, msg, raw } from "./test-helpers";

const prompt = { version: "test.v1", system: "system text" };
const messages = [
  msg(1, "2030-01-05 18:00", "person_1", "see you at the cafe"),
  msg(2, "2030-01-05 18:30", "person_2", "reached!"),
];
const options = { labels: LABELS };

function scripted(replies: string[]): ChatModel & { requests: string[] } {
  const requests: string[] = [];
  let next = 0;
  return {
    model: "test-model",
    requests,
    async complete(request: ChatRequest) {
      requests.push(request.user);
      const text = replies[Math.min(next++, replies.length - 1)] as string;
      return { text, usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, costInr: 0.01 } };
    },
  };
}

const reply = (events: unknown[]) => JSON.stringify({ events });

describe("extractWindow", () => {
  const window = buildWindows(messages, options)[0]!;

  test("parses a valid reply, with or without a code fence", async () => {
    const model = scripted(["```json\n" + reply([raw()]) + "\n```"]);
    const result = await extractWindow(model, prompt, window);
    expect(result.events).toHaveLength(1);
    expect(result.attempts).toBe(1);
  });

  test("an empty list is a normal outcome", async () => {
    const result = await extractWindow(scripted([reply([])]), prompt, window);
    expect(result.events).toEqual([]);
  });

  test("retries on bad JSON and on a schema miss, and sums the cost of every attempt", async () => {
    const model = scripted(["not json", JSON.stringify({ events: [{ category: 1 }] }), reply([raw()])]);
    const result = await extractWindow(model, prompt, window);
    expect(result.attempts).toBe(3);
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 15, cachedInputTokens: 0, costInr: 0.03 });
    expect(model.requests[1]).toContain("not valid JSON");
    expect(model.requests[2]).toContain("events.0.category");
  });

  test("the retry note never echoes the model's values", async () => {
    const model = scripted([JSON.stringify({ events: [{ category: "SECRET-TEXT" }] }), reply([])]);
    await extractWindow(model, prompt, window);
    expect(model.requests[1]).not.toContain("SECRET-TEXT");
  });

  test("gives up after the attempt limit", async () => {
    const model = scripted(["nope"]);
    await expect(extractWindow(model, prompt, window, 2)).rejects.toBeInstanceOf(InvalidReplyError);
    expect(model.requests).toHaveLength(2);
  });

  test("an unknown cost makes the total unknown", async () => {
    const model: ChatModel = {
      model: "m",
      complete: async () => ({
        text: reply([]),
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costInr: null },
      }),
    };
    expect((await extractWindow(model, prompt, window)).usage.costInr).toBeNull();
  });
});

describe("extractSession", () => {
  test("validates in code: keeps good events, drops ones the model should not have made", async () => {
    const model = scripted([
      reply([
        raw(),
        raw({ evidence: [{ ref: "m77", role: "primary" }] }),
        raw({ category: "Running joke" }),
        raw({ occurred_at: "2031-01-05 18:00" }),
      ]),
    ]);
    const result = await extractSession(model, prompt, messages, options);
    expect(result.proposed).toBe(4);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.window).toBe(0);
    expect(result.dropped.map((d) => d.reason)).toEqual([
      "no_evidence",
      "running_joke_in_pass_1",
      "date_outside_evidence",
    ]);
  });

  test("a session with only system lines costs nothing and returns nothing", async () => {
    const model = scripted([reply([raw()])]);
    const result = await extractSession(
      model,
      prompt,
      [msg(1, "2030-01-05 18:00", "person_1", "x", { kind: "system" })],
      options,
    );
    expect(result.windows).toBe(0);
    expect(result.candidates).toEqual([]);
    expect(model.requests).toHaveLength(0);
  });

  test("a long session calls the model once per window and tags each candidate with its window", async () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      msg(i + 1, `2030-01-05 18:${String(i).padStart(2, "0")}`, "person_1", `line ${i}`),
    );
    const model = scripted([
      reply([raw({ evidence: [{ ref: "m1", role: "primary" }], occurred_at: "2030-01-05 18:00" })]),
      reply([raw({ title: "Later one", evidence: [{ ref: "m10", role: "primary" }] })]),
    ]);
    const result = await extractSession(model, prompt, many, { ...options, maxMessages: 6, overlap: 2 });
    expect(result.windows).toBe(2);
    expect(result.candidates.map((c) => c.window)).toEqual([0, 1]);
    expect(model.requests[1]).toContain("Window 2 of 2");
  });

  test("the transcript the model sees uses the real names", async () => {
    const model = scripted([reply([])]);
    await extractSession(model, prompt, messages, options);
    expect(model.requests[0]).toContain("Ravi ig: see you at the cafe");
    expect(model.requests[0]).toContain("Anita ig: reached!");
  });
});

describe("length cut-offs", () => {
  const usage = { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, costInr: 0.01 };
  const four = Array.from({ length: 4 }, (_, i) =>
    msg(i + 1, `2030-01-05 18:0${i}`, "person_1", `line ${i}`),
  );

  test("a window cut at the output limit is split in two, and both halves are asked", async () => {
    const requests: string[] = [];
    const titles = ["first half", "second half"];
    const model: ChatModel = {
      model: "test-model",
      async complete(request: ChatRequest) {
        requests.push(request.user);
        if (requests.length === 1) throw new SarvamError(200, "length", false, "bedrock");
        const title = titles[requests.length - 2] as string;
        return {
          text: reply([raw({ title, evidence: [{ ref: "m1", role: "primary" }], occurred_at: "2030-01-05 18:00" })]),
          usage,
        };
      },
    };
    const result = await extractSession(model, prompt, four, options);
    expect(requests).toHaveLength(3);
    expect(requests[1]).toContain("m1]");
    expect(requests[2]).toContain("m4]");
    expect(result.windows).toBe(1);
    expect(result.candidates.map((c) => c.window)).toEqual([0, 0]);
    expect(result.candidates.map((c) => c.title)).toEqual(titles);
  });

  test("a single message cut at the output limit fails instead of splitting forever", async () => {
    const model: ChatModel = {
      model: "test-model",
      complete: async () => {
        throw new SarvamError(200, "length", false, "bedrock");
      },
    };
    const one = [msg(1, "2030-01-05 18:00", "person_1", "hi")];
    await expect(extractSession(model, prompt, one, options)).rejects.toMatchObject({ code: "length" });
  });

  test("other errors are not split", async () => {
    const model: ChatModel = {
      model: "test-model",
      complete: async () => {
        throw new SarvamError(503, "service", true, "bedrock");
      },
    };
    await expect(extractSession(model, prompt, four, options)).rejects.toMatchObject({ status: 503 });
  });
});

describe("prompt file", () => {
  test("the versioned prompt exists and states the hard rules", () => {
    const loaded = loadPrompt();
    expect(loaded.version).toBe("extract.v1");
    expect(loaded.system).toContain("No evidence, no event");
    expect(loaded.system).toContain("Do not infer or read between the lines");
    for (const category of ["Milestone", "Meetup", "Trip", "Celebration", "Plan", "Conflict", "Saying", "Life update"]) {
      expect(loaded.system).toContain(`\`${category}\``);
    }
  });

  test("the prompt names the Life update exception and does not use me or her labels", () => {
    const loaded = loadPrompt();
    expect(loaded.system).toContain("one day before");
    expect(loaded.system).not.toMatch(/`me`|`her`/);
  });

  test("rejects a version that is a path", () => {
    expect(() => loadPrompt("../secrets")).toThrow();
  });
});
