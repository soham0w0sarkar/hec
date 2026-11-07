import type { SQL } from "bun";
import type { EmbedMany } from "./openai";
import { CHUNK_LIMITS, splitChunks, type ChunkLine } from "./split";

export type EmbedReport = {
  sessions: number;
  embedded: number;
  skipped: number;
  chunks: number;
};

type MessageRow = {
  id: string | number;
  body: string | null;
  source: string;
  kind: string;
  sent_at_ist: string | null;
  name: string;
};

const BATCH = 32;
const LINE_CAP = 500;

/**
 * Writes one chunk per slice of each session that does not already have this model.
 * `force` replaces every session. Logs counts only, never a transcript.
 */
export async function embedSessions(
  sql: SQL,
  embedder: EmbedMany,
  options: { force?: boolean; log?: (line: string) => void } = {},
): Promise<EmbedReport> {
  const log = options.log ?? (() => {});
  const sessions = options.force
    ? ((await retryPooler(() => sql`select id from sessions order by id`)) as { id: string | number }[])
    : ((await retryPooler(() => sql`
        select s.id
        from sessions s
        where not exists (
          select 1 from chunks c
          where c.session_id = s.id and c.embedding_model = ${embedder.model} and c.embedding is not null
        )
        order by s.id
      `)) as { id: string | number }[]);

  const report: EmbedReport = { sessions: sessions.length, embedded: 0, skipped: 0, chunks: 0 };
  for (const session of sessions) {
    const sessionId = Number(session.id);
    const rows = (await retryPooler(() => sql`
      select m.id, m."text" as body, m.source, m.kind, p.name, format_display_time(m.sent_at) as sent_at_ist
      from messages m
      join people p on p.id = m.person_id
      where m.session_id = ${sessionId}
        and m.kind not in ('system', 'unsent')
      order by m.sent_at, m.id
    `)) as MessageRow[];
    const lines = rows.map(toLine);
    const drafts = splitChunks(lines, CHUNK_LIMITS);
    if (drafts.length === 0) {
      report.skipped += 1;
      continue;
    }
    const vectors: number[][] = [];
    for (let index = 0; index < drafts.length; index += BATCH) {
      const batch = drafts.slice(index, index + BATCH).map((draft) => draft.transcript);
      vectors.push(...(await embedder.embedMany(batch)));
    }
    await retryPooler(() => sql.begin(async (tx) => {
      const db = tx as unknown as SQL;
      await db`delete from chunks where session_id = ${sessionId}`;
      for (let index = 0; index < drafts.length; index++) {
        const draft = drafts[index]!;
        const vector = vectors[index]!;
        await db.unsafe(
          `insert into chunks (
             session_id, position, first_message_id, last_message_id, message_count, transcript, embedding, embedding_model
           ) values ($1, $2, $3, $4, $5, $6, $7::vector, $8)
           on conflict (session_id, position) do update set
             first_message_id = excluded.first_message_id,
             last_message_id = excluded.last_message_id,
             message_count = excluded.message_count,
             transcript = excluded.transcript,
             embedding = excluded.embedding,
             embedding_model = excluded.embedding_model`,
          [
            sessionId,
            draft.position,
            draft.firstMessageId,
            draft.lastMessageId,
            draft.messageCount,
            draft.transcript,
            `[${vector.join(",")}]`,
            embedder.model,
          ],
        );
      }
    }));
    report.embedded += 1;
    report.chunks += drafts.length;
    if (report.embedded % 25 === 0) log(`embedded ${report.embedded} sessions, ${report.chunks} chunks`);
  }
  log(`embedded ${report.embedded} sessions, skipped ${report.skipped}, ${report.chunks} chunks`);
  return report;
}

/** The transaction pooler sometimes drops an unnamed statement. The session write is safe to repeat. */
async function retryPooler<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      const errno = error && typeof error === "object" && "errno" in error ? String(error.errno) : "";
      const message = error instanceof Error ? error.message : "";
      const locked = errno === "57014" || message.includes("statement timeout") || message.includes("lock");
      if (errno !== "26000" && errno !== "08P01" && !locked && !message.includes("prepared statement") && !message.includes("bind message")) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw last;
}

function toLine(row: MessageRow): ChunkLine {
  const id = Number(row.id);
  let body = (row.body ?? "").replace(/\s+/g, " ").trim();
  if (body.length > LINE_CAP) body = `${body.slice(0, LINE_CAP)}…`;
  if (row.kind !== "text") body = body === "" ? `<${row.kind}>` : `<${row.kind}> ${body}`;
  const source = row.source === "whatsapp" ? "wa" : "ig";
  const when = (row.sent_at_ist ?? "").slice(0, 16);
  return { id, line: `[m${id}] ${when} ${row.name} ${source}: ${body}` };
}
