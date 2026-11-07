import { EMBEDDING_DIMENSIONS } from "@hec/core";

export type EmbedMany = {
  readonly model: string;
  embed(text: string): Promise<readonly number[]>;
  embedMany(texts: readonly string[]): Promise<number[][]>;
};

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";

/**
 * OpenAI embeddings. The width is fixed to the chunks column.
 * Errors name the HTTP status only, never the text that was sent.
 */
export function createOpenAIEmbeddings(
  options: {
    apiKey: string;
    model: string;
    fetch?: FetchLike;
    sleep?: (ms: number) => Promise<void>;
  },
): EmbedMany {
  if (!options.apiKey.trim()) throw new Error("OPENAI_API_KEY is not set");
  if (!options.model.trim()) throw new Error("OPENAI_EMBEDDING_MODEL is not set");
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const model = options.model.trim();

  return {
    model,
    embed(text: string) {
      return embedMany(doFetch, sleep, options.apiKey, model, [text]).then((vectors) => vectors[0]!);
    },
    embedMany(texts: readonly string[]) {
      return embedMany(doFetch, sleep, options.apiKey, model, texts);
    },
  };
}

async function embedMany(
  doFetch: FetchLike,
  sleep: (ms: number) => Promise<void>,
  apiKey: string,
  model: string,
  texts: readonly string[],
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const body = JSON.stringify({ model, input: [...texts], dimensions: EMBEDDING_DIMENSIONS });
  let lastStatus = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(400 * attempt);
    const response = await doFetch(OPENAI_EMBEDDINGS_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body,
    });
    if (response.status === 429 || response.status >= 500) {
      lastStatus = response.status;
      continue;
    }
    if (!response.ok) throw new Error(`embedding request failed with HTTP ${response.status}`);
    return readVectors(await response.json(), texts.length);
  }
  throw new Error(`embedding request failed with HTTP ${lastStatus}`);
}

function readVectors(body: unknown, count: number): number[][] {
  const data = (body as { data?: { index?: number; embedding?: unknown }[] }).data;
  if (!Array.isArray(data) || data.length !== count) throw new Error("embedding response did not match the batch");
  const vectors = Array.from({ length: count }, () => [] as number[]);
  for (const item of data) {
    const index = item.index;
    if (typeof index !== "number" || index < 0 || index >= count) throw new Error("embedding response did not match the batch");
    if (!Array.isArray(item.embedding) || item.embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`embedding width must be ${EMBEDDING_DIMENSIONS}`);
    }
    vectors[index] = item.embedding.map((value) => {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("embedding values must be finite");
      return value;
    });
  }
  if (vectors.some((vector) => vector.length !== EMBEDDING_DIMENSIONS)) {
    throw new Error("embedding response did not match the batch");
  }
  return vectors;
}
