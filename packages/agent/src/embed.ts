import { EMBEDDING_DIMENSIONS } from "@hec/core";

/** Turns a search phrase into a vector. The agent does not know which provider this is. */
export type Embedder = {
  readonly model: string;
  embed(text: string): Promise<readonly number[]>;
};

/**
 * Same text, same vector, no network. The width matches the chunks column so a test can call retrieval.
 */
export function fakeEmbedder(model = "test-embed"): Embedder {
  return {
    model,
    async embed(text: string) {
      const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
      let hash = 0;
      for (let i = 0; i < text.length; i++) hash = (Math.imul(hash, 33) + text.charCodeAt(i)) >>> 0;
      const slot = hash % vector.length;
      vector[slot] = 1;
      return vector;
    },
  };
}
