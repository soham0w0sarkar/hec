import { createDb } from "@hec/db";
import { createOpenAIEmbeddings } from "./openai";
import { embedSessions } from "./run";

const model = process.env.OPENAI_EMBEDDING_MODEL?.trim() || "text-embedding-3-small";
const apiKey = process.env.OPENAI_API_KEY ?? "";
const force = process.argv.includes("--force");

console.log(`embedding with ${model}`);

const sql = createDb(process.env.DATABASE_URL, { max: 1 });
try {
  const report = await embedSessions(sql, createOpenAIEmbeddings({ apiKey, model }), {
    force,
    log: (line) => console.log(line),
  });
  console.log(
    `done: sessions ${report.sessions}, embedded ${report.embedded}, skipped ${report.skipped}, chunks ${report.chunks}`,
  );
} finally {
  await sql.close();
}
