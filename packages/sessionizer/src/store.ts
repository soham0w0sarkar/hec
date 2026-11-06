import type { SQL } from "bun";
import type { MessageKind, MessageSource } from "@hec/core";
import { ASSIGN_BATCH, assignmentSlices, type Assignment } from "./assign";
import { buildSessions, type SessionDraft, type SessionMessage } from "./group";
import { runPool } from "./pool";
import { DEFAULT_SESSION_WORKERS } from "./workers";

const RUN_LOCK = "sessionize";

export type SessionizeOptions = {
  workers?: number;
  gapMs?: number;
  batchSize?: number;
  onSlice?: (report: { worker: number; assigned: number }) => void;
};

export async function loadSessionMessages(sql: SQL): Promise<SessionMessage[]> {
  const rows = await sql<{ id: string | number; sent_at: Date | string; source: MessageSource; kind: MessageKind }[]>`
    select id, sent_at, source, kind
    from messages
    order by sent_at, id
  `;

  return rows.map((row) => ({
    id: asId(row.id),
    sentAt: row.sent_at instanceof Date ? row.sent_at : new Date(row.sent_at),
    source: row.source,
    kind: row.kind,
  }));
}

/**
 * Groups every message in one pass, inserts every session in one statement, then lets workers
 * write `session_id` for disjoint slices. The pool needs a free connection for the run lock
 * plus one per worker (`max` of at least `workers + 1`).
 *
 * The run lock is held for the whole rebuild, so a second process is told to stop. Slice locks
 * stop two writers from updating the same messages. Writes commit per slice: a crash leaves a
 * partial assignment, and the next run deletes every session and fills them in again.
 */
export async function sessionize(
  sql: SQL,
  options: SessionizeOptions = {},
): Promise<{ sessions: SessionDraft[]; messages: number; slices: number }> {
  const workers = options.workers ?? DEFAULT_SESSION_WORKERS;
  const messages = await loadSessionMessages(sql);
  const drafts = buildSessions(messages, options.gapMs);

  let slices = 0;
  await sql.begin(async (lockTx) => {
    if (!(await tryLock(lockTx, RUN_LOCK))) throw new Error("sessionize is already running");

    const sessionIds = await sql.begin(async (tx) => {
      await widen(tx);
      await tx`delete from sessions`;
      return insertSessions(tx, drafts);
    });

    const work = assignmentSlices(assignmentsFor(drafts, sessionIds), options.batchSize ?? ASSIGN_BATCH);
    slices = work.length;
    await runPool(work, workers, async (slice, worker) => {
      const assigned = await sql.begin(async (tx) => {
        await widen(tx);
        if (!(await tryLock(tx, `sessionize:slice:${slice.key}`))) {
          throw new Error("sessionize slice is held by another run");
        }
        return assignSlice(tx, slice.rows);
      });
      if (assigned !== slice.rows.length) {
        throw new Error(`slice updated ${assigned} of ${slice.rows.length} messages`);
      }
      options.onSlice?.({ worker, assigned });
    });
  });

  const assigned = drafts.reduce((total, draft) => total + draft.messageIds.length, 0);
  return { sessions: drafts, messages: assigned, slices };
}

async function insertSessions(tx: SQL, drafts: SessionDraft[]): Promise<number[]> {
  if (drafts.length === 0) return [];

  const rows = drafts.map((draft, ordinal) => ({
    ordinal,
    started_at: draft.startedAt.toISOString(),
    ended_at: draft.endedAt.toISOString(),
    message_count: draft.messageIds.length,
    sources: draft.sources,
  }));
  // `ordinal` is not a sessions column, and RETURNING cannot see the SELECT list.
  // nextval assigns the ids up front so each ordinal comes back with the id that was inserted.
  const returned = await tx<{ id: string | number; ordinal: string | number }[]>`
    with incoming as (
      select ordinal,
             started_at,
             ended_at,
             message_count,
             array(select jsonb_array_elements_text(sources))::message_source[] as sources,
             nextval(pg_get_serial_sequence('sessions', 'id')) as id
      from jsonb_to_recordset(${rows}::jsonb) as raw (
        ordinal int,
        started_at timestamptz,
        ended_at timestamptz,
        message_count int,
        sources jsonb
      )
    ),
    inserted as (
      insert into sessions (id, started_at, ended_at, message_count, sources)
      overriding system value
      select id, started_at, ended_at, message_count, sources
      from incoming
      returning id
    )
    select incoming.ordinal, incoming.id
    from incoming
    join inserted on inserted.id = incoming.id
  `;

  const ids = new Array<number>(drafts.length);
  for (const row of returned) {
    const ordinal = asId(row.ordinal);
    if (ids[ordinal] !== undefined) throw new Error(`duplicate session ordinal ${ordinal}`);
    ids[ordinal] = asId(row.id);
  }
  if (ids.some((id) => id === undefined)) throw new Error("session insert did not return every id");
  return ids;
}

function assignmentsFor(drafts: SessionDraft[], sessionIds: number[]): Assignment[] {
  const assignments: Assignment[] = [];
  drafts.forEach((draft, index) => {
    const sessionId = sessionIds[index];
    if (sessionId === undefined) throw new Error(`missing id for session ${index}`);
    for (const id of draft.messageIds) assignments.push({ id, sessionId });
  });
  return assignments;
}

async function assignSlice(tx: SQL, rows: { id: number; session_id: number }[]): Promise<number> {
  const counted = await tx<{ assigned: number }[]>`
    with updated as (
      update messages as m
      set session_id = v.session_id
      from jsonb_to_recordset(${rows}::jsonb) as v(id bigint, session_id bigint)
      where m.id = v.id
      returning 1
    )
    select count(*)::int as assigned from updated
  `;
  return counted[0]?.assigned ?? 0;
}

async function tryLock(tx: SQL, key: string): Promise<boolean> {
  const rows = await tx<{ locked: boolean }[]>`
    select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as locked
  `;
  return rows[0]?.locked === true;
}

async function widen(tx: SQL): Promise<void> {
  await tx`set local statement_timeout = '10min'`;
}

function asId(value: string | number): number {
  const id = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(id)) throw new Error(`id ${value} is out of range`);
  return id;
}
