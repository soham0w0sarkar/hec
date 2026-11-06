import { createHash } from "node:crypto";
import type { SQL } from "bun";
import { MESSAGE_SOURCES, type MessageSource } from "@hec/core";
import type { IngestConfig } from "./config";
import { DEDUPE_WINDOW_MS, dedupeText, type DedupeRow } from "./dedupe";
import type { ResolvedMessage } from "./resolve";

const INSERT_BATCH = 500;

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function loadDisplayTimezone(sql: SQL): Promise<string> {
  const rows = await sql<{ display_timezone: string }[]>`
    select display_timezone from app_settings where id = 1
  `;
  const timezone = rows[0]?.display_timezone;
  if (!timezone) throw new Error("app_settings.display_timezone is missing");
  return timezone;
}

export async function replaceIdentities(sql: SQL, config: IngestConfig): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${"ingest:identities"}, 0))`;
    for (const source of MESSAGE_SOURCES) {
      await tx`delete from source_identities where source = ${source}`;
      for (const [rawName, personId] of Object.entries(config.identity[source])) {
        await tx`
          insert into source_identities (source, raw_name, person_id)
          values (${source}, ${rawName}, ${personId})
        `;
      }
    }
  });
}

/** Held until the transaction ends. Another worker or process gets false. */
export async function tryLockFile(tx: SQL, source: MessageSource, fileHash: string): Promise<boolean> {
  const rows = await tx<{ locked: boolean }[]>`
    select pg_try_advisory_xact_lock(hashtextextended(${`ingest:file:${source}:${fileHash}`}, 0)) as locked
  `;
  return rows[0]?.locked === true;
}

/**
 * The duplicate check only sees committed rows, so files from two different apps must not
 * check and insert at the same time. Files from the same app never dedupe against each other
 * and may overlap. For each pair of apps the first (by name) takes the lock shared and the
 * second exclusive, always in the same key order, so the waits cannot deadlock.
 */
export async function waitForOtherSources(tx: SQL, source: MessageSource): Promise<void> {
  const pairs = MESSAGE_SOURCES.filter((other) => other !== source)
    .map((other) => {
      const [first, second] = [source, other].sort();
      return { key: `ingest:dedupe:${first}:${second}`, exclusive: source === second };
    })
    .sort((a, b) => a.key.localeCompare(b.key));

  for (const pair of pairs) {
    if (pair.exclusive) await tx`select pg_advisory_xact_lock(hashtextextended(${pair.key}, 0))`;
    else await tx`select pg_advisory_xact_lock_shared(hashtextextended(${pair.key}, 0))`;
  }
}

export async function hasSucceeded(sql: SQL, source: MessageSource, fileHash: string): Promise<boolean> {
  const rows = await sql`
    select 1 as found
    from ingest_runs
    where source = ${source} and file_hash = ${fileHash} and status = 'succeeded'
    limit 1
  `;
  return rows.length > 0;
}

export type RunRecord = {
  source: MessageSource;
  fileName: string;
  fileHash: string;
  startedAt: Date;
  seen: number;
} & ({ status: "succeeded"; inserted: number; skipped: number } | { status: "failed"; error: string });

export async function recordRun(sql: SQL, run: RunRecord): Promise<void> {
  const inserted = run.status === "succeeded" ? run.inserted : 0;
  const skipped = run.status === "succeeded" ? run.skipped : 0;
  const error = run.status === "failed" ? run.error.slice(0, 2000) : null;
  await sql`
    insert into ingest_runs (
      source, file_name, file_hash, rows_seen, rows_inserted, rows_skipped, status, error, started_at, finished_at
    )
    values (
      ${run.source}, ${run.fileName}, ${run.fileHash}, ${run.seen}, ${inserted}, ${skipped},
      ${run.status}, ${error}, ${run.startedAt}, now()
    )
  `;
}

/** Stored rows from the other apps that could duplicate `messages`. */
export async function storedForDedupe(
  sql: SQL,
  messages: ResolvedMessage[],
  source: MessageSource,
): Promise<DedupeRow[]> {
  const texts = [...new Set(messages.map((message) => dedupeText(message.text)).filter((text) => text !== ""))];
  if (texts.length === 0) return [];

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const message of messages) {
    const time = message.sentAt.getTime();
    if (time < min) min = time;
    if (time > max) max = time;
  }

  const rows = await sql<{ person_id: DedupeRow["personId"]; source: DedupeRow["source"]; text: string; sent_at: Date | string }[]>`
    select person_id, source, "text", sent_at
    from messages
    where source <> ${source}
      and sent_at between ${new Date(min - DEDUPE_WINDOW_MS)} and ${new Date(max + DEDUPE_WINDOW_MS)}
      and regexp_replace("text", '^[[:space:]]+|[[:space:]]+$', '', 'g')
          in (select jsonb_array_elements_text(${texts}::jsonb))
  `;

  return rows.map((row) => ({
    personId: row.person_id,
    source: row.source,
    text: row.text,
    sentAt: row.sent_at instanceof Date ? row.sent_at : new Date(row.sent_at),
  }));
}

export async function insertMessages(sql: SQL, messages: ResolvedMessage[]): Promise<number> {
  let inserted = 0;
  for (let offset = 0; offset < messages.length; offset += INSERT_BATCH) {
    const batch = messages.slice(offset, offset + INSERT_BATCH).map((message) => ({
      person_id: message.personId,
      sent_at: message.sentAt.toISOString(),
      body: message.text,
      source: message.source,
      source_ref: message.sourceRef,
      kind: message.kind,
      extras: message.extras,
    }));
    const rows = await sql`
      insert into messages (person_id, sent_at, "text", source, source_ref, kind, extras)
      select person_id, sent_at, body, source::message_source, source_ref, kind::message_kind, extras
      from jsonb_to_recordset(${batch}::jsonb) as incoming (
        person_id text,
        sent_at timestamptz,
        body text,
        source text,
        source_ref text,
        kind text,
        extras jsonb
      )
      on conflict (source, source_ref) do nothing
      returning source_ref
    `;
    inserted += rows.length;
  }
  return inserted;
}

export async function refreshDailyStats(sql: SQL): Promise<void> {
  await sql`select refresh_daily_stats()`;
}
