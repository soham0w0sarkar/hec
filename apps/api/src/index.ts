import { createDb } from "@hec/db";
import { createOpenAIEmbeddings } from "@hec/embeddings";
import { createSarvamChat } from "@hec/llm";
import type { SQL } from "bun";
import { answerQuestion } from "./chat";
import { createApi } from "./http";
import { redisChatMemory } from "./memory";

const port = portFrom(process.env.PORT);
const host = process.env.HOST?.trim() || "127.0.0.1";
const sql = createDb(process.env.DATABASE_URL, { max: 4 });
const model = createSarvamChat({
  apiKey: process.env.SARVAM_API_KEY ?? "",
  model: process.env.SARVAM_MODEL?.trim() || "sarvam-105b",
});
const embedder = openEmbedder();
const memory = redisChatMemory(process.env.REDIS_URL ?? "");
let chunksModel: { at: number; model: string | null } = { at: 0, model: null };

const api = createApi({
  sql,
  memory,
  answer: (input) =>
    answerQuestion(input, {
      sql,
      model,
      embedder,
      chunksModel: chunksModel.model,
      log: (entry) =>
        console.log(
          `chat ${entry.runId} ${entry.verdict} steps ${entry.steps} tools ${entry.toolCalls} ${entry.ms}ms${entry.personaFallback ? " voice-fallback" : ""}`,
        ),
    }),
});

const server = Bun.serve({
  hostname: host,
  port,
  async fetch(request) {
    try {
      await refreshChunksModel(sql);
    } catch {
      chunksModel = { at: Date.now(), model: null };
    }
    return api.fetch(request);
  },
});

console.log(`hec api on http://${host}:${server.port}`);

async function refreshChunksModel(db: SQL): Promise<void> {
  if (Date.now() - chunksModel.at < 30_000) return;
  const rows = (await db`
    select embedding_model from chunks where embedding_model is not null group by embedding_model limit 2
  `) as { embedding_model: string }[];
  chunksModel = { at: Date.now(), model: rows.length === 1 ? (rows[0]?.embedding_model ?? null) : null };
}

function openEmbedder() {
  const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  const modelName = process.env.OPENAI_EMBEDDING_MODEL?.trim() || "text-embedding-3-small";
  if (!apiKey) return null;
  const client = createOpenAIEmbeddings({ apiKey, model: modelName });
  return { model: client.model, embed: (text: string) => client.embed(text) };
}

function portFrom(raw: string | undefined): number {
  const value = Number(raw ?? 3001);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error("PORT is not valid");
  return value;
}
