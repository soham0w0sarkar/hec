import { describe, expect, test } from "bun:test";
import { EMBEDDING_DIMENSIONS } from "@hec/core";
import { createOpenAIEmbeddings } from "./openai";

describe("createOpenAIEmbeddings", () => {
  test("sends the model and width, and retries a 429", async () => {
    const seen: { authorization?: string; body?: unknown }[] = [];
    let calls = 0;
    const embedder = createOpenAIEmbeddings({
      apiKey: "test-key",
      model: "text-embedding-3-small",
      sleep: async () => {},
      fetch: async (_url, init) => {
        calls += 1;
        const headers = init.headers as Record<string, string>;
        seen.push({ authorization: headers.authorization, body: JSON.parse(String(init.body)) });
        if (calls === 1) return new Response("busy", { status: 429 });
        const embedding = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.1);
        return Response.json({ data: [{ index: 0, embedding }] });
      },
    });

    const vector = await embedder.embed("hello");
    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(calls).toBe(2);
    expect(seen[0]?.authorization).toBe("Bearer test-key");
    expect(seen[0]?.body).toEqual({ model: "text-embedding-3-small", input: ["hello"], dimensions: EMBEDDING_DIMENSIONS });
  });

  test("rejects a vector of the wrong width", async () => {
    const embedder = createOpenAIEmbeddings({
      apiKey: "test-key",
      model: "text-embedding-3-small",
      fetch: async () => Response.json({ data: [{ index: 0, embedding: [1, 2] }] }),
    });
    await expect(embedder.embed("hello")).rejects.toThrow(`embedding width must be ${EMBEDDING_DIMENSIONS}`);
  });
});
