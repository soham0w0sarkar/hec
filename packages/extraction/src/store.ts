import type { SQL } from "bun";
import {
  PERSON_IDS,
  type DatePrecision,
  type EventStatus,
  type EvidenceRole,
  type FirstCheck,
  type MessageKind,
  type MessageSource,
  type PersonId,
  type RunStatus,
  type Significance,
} from "@hec/core";
import type { Usage } from "@hec/llm";
import type { FinalEvent } from "./pipeline";
import type { SessionCandidates } from "./merge";
import type { Dropped } from "./validate";
import type { ReviewEvent, ReviewUpdate } from "./review";
import type { WindowedCandidate } from "./extract";
import type { ExtractionMessage, SpeakerLabels } from "./types";

export type RunRow = {
  id: number;
  status: RunStatus;
  model: string;
  promptVersion: string;
  sessionCount: number;
};

/** What a successful pass 1 job writes. Holds validated events only, never raw message text. */
export type SessionOutcome = {
  windowCount: number;
  proposedCount: number;
  attempts: number;
  candidates: WindowedCandidate[];
  dropped: Dropped[];
  usage: Usage;
};

export type SessionStates = Map<number, "succeeded" | "failed">;

export type RunTotals = {
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  costInr: number | null;
};

export type FinalizeResult = { status: "finalized"; events: number } | { status: "skipped"; reason: string };

/**
 * Everything extraction reads and writes. The SQL implementation below is the real one. Jobs and
 * the finalize logic are tested against an in-memory version of this interface.
 */
export interface ExtractionStore {
  speakerLabels(): Promise<SpeakerLabels>;
  sessionIds(): Promise<number[]>;
  /** Null when the session no longer exists, for example after sessionize rebuilt the sessions. */
  sessionMessages(sessionId: number): Promise<ExtractionMessage[] | null>;

  createRun(input: { model: string; promptVersion: string; sessionCount: number }): Promise<number>;
  getRun(runId: number): Promise<RunRow | null>;
  /** False when the run was already finalized, so the write was not made. */
  saveOutcome(runId: number, sessionId: number, outcome: SessionOutcome): Promise<boolean>;
  saveFailure(runId: number, sessionId: number, message: string): Promise<boolean>;
  sessionStates(runId: number): Promise<SessionStates>;

  /**
   * Writes the run's events in one transaction, after `build` has merged and checked them. Locks
   * the run so a session cannot be saved mid-way. Skips if the run is not open or a session is
   * not succeeded yet.
   */
  finalize(runId: number, build: (sessions: SessionCandidates[]) => Promise<FinalEvent[]>): Promise<FinalizeResult>;
  runTotals(runId: number): Promise<RunTotals>;

  latestFinalizedRunId(): Promise<number | null>;
  runEvents(runId: number): Promise<ReviewEvent[]>;
  applyReview(runId: number, updates: ReviewUpdate[], current: readonly ReviewEvent[]): Promise<number>;
};

export class RunClosedError extends Error {
  constructor(runId: number) {
    super(`extraction run ${runId} is already finalized`);
    this.name = "RunClosedError";
  }
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

type CandidateJson = {
  category: string;
  title: string;
  summary: string;
  occurredAt: string;
  datePrecision: DatePrecision;
  endedAt: string | null;
  significance: number;
  isFirst: boolean;
  firstOf: string | null;
  saying: { personId: PersonId; quote: string } | null;
  evidence: { messageId: number; role: EvidenceRole }[];
  evidenceFrom: string;
  evidenceTo: string;
  window: number;
};

export function serializeCandidate(candidate: WindowedCandidate): CandidateJson {
  return {
    category: candidate.category,
    title: candidate.title,
    summary: candidate.summary,
    occurredAt: candidate.occurredAt.toISOString(),
    datePrecision: candidate.datePrecision,
    endedAt: candidate.endedAt?.toISOString() ?? null,
    significance: candidate.significance,
    isFirst: candidate.isFirst,
    firstOf: candidate.firstOf,
    saying: candidate.saying,
    evidence: candidate.evidence,
    evidenceFrom: candidate.evidenceFrom.toISOString(),
    evidenceTo: candidate.evidenceTo.toISOString(),
    window: candidate.window,
  };
}

/**
 * Rows written before the `::text::jsonb` fix hold the JSON array as a JSON string. Both forms are
 * read the same way, so finalize works on old and new rows.
 */
function candidatesOf(stored: CandidateJson[] | string): CandidateJson[] {
  const value: unknown = typeof stored === "string" ? JSON.parse(stored) : stored;
  if (!Array.isArray(value)) throw new Error("stored candidates are not a list");
  return value as CandidateJson[];
}

export function deserializeCandidate(json: CandidateJson): WindowedCandidate {
  return {
    category: json.category as WindowedCandidate["category"],
    title: json.title,
    summary: json.summary,
    occurredAt: new Date(json.occurredAt),
    datePrecision: json.datePrecision,
    endedAt: json.endedAt === null ? null : new Date(json.endedAt),
    significance: json.significance as Significance,
    isFirst: json.isFirst,
    firstOf: json.firstOf,
    saying: json.saying,
    evidence: json.evidence,
    evidenceFrom: new Date(json.evidenceFrom),
    evidenceTo: new Date(json.evidenceTo),
    window: json.window,
  };
}

/** Pass 1 errors may hold a model's problem summary, which never contains message text. Anything else gets its class only. */
export function describeFailure(error: unknown): string {
  if (error instanceof Error && (error.name === "InvalidReplyError" || error.name === "SarvamError")) {
    return error.message;
  }
  return `unexpected ${error instanceof Error ? error.name : "error"}`;
}

const num = (value: unknown): number => Number(value ?? 0);
const nullableNum = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const toDate = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));

export function createSqlStore(sql: SQL): ExtractionStore {
  return {
    async speakerLabels() {
      const rows = await sql<{ id: string; name: string }[]>`select id, name from people`;
      const labels = {} as SpeakerLabels;
      for (const id of PERSON_IDS) {
        const row = rows.find((r) => r.id === id);
        if (!row || row.name.trim() === "") throw new Error(`people row "${id}" has no name`);
        labels[id] = row.name;
      }
      return labels;
    },

    async sessionIds() {
      const rows = await sql<{ id: string | number }[]>`select id from sessions order by started_at, id`;
      return rows.map((row) => Number(row.id));
    },

    async sessionMessages(sessionId) {
      const exists = await sql<{ id: string | number }[]>`select id from sessions where id = ${sessionId}`;
      if (exists.length === 0) return null;
      const rows = await sql<
        { id: string | number; person_id: PersonId; sent_at: Date | string; text: string; source: MessageSource; kind: MessageKind }[]
      >`
        select id, person_id, sent_at, "text", source, kind
        from messages
        where session_id = ${sessionId}
          and kind not in ('system', 'unsent')
          and not (kind = 'share' and coalesce(extras->'share'->>'link', '') ilike '%instagram.com/reel/%')
        order by sent_at, id
      `;
      return rows.map((row) => ({
        id: Number(row.id),
        personId: row.person_id,
        sentAt: toDate(row.sent_at),
        text: row.text,
        source: row.source,
        kind: row.kind,
      }));
    },

    async createRun(input) {
      const [row] = await sql<{ id: string | number }[]>`
        insert into extraction_runs (model, prompt_version, session_count)
        values (${input.model}, ${input.promptVersion}, ${input.sessionCount})
        returning id
      `;
      return Number(row?.id);
    },

    async getRun(runId) {
      const [row] = await sql<
        { id: string | number; status: RunStatus; model: string; prompt_version: string; session_count: number | null }[]
      >`select id, status, model, prompt_version, session_count from extraction_runs where id = ${runId}`;
      if (!row) return null;
      return {
        id: Number(row.id),
        status: row.status,
        model: row.model,
        promptVersion: row.prompt_version,
        sessionCount: num(row.session_count),
      };
    },

    async saveOutcome(runId, sessionId, outcome) {
      return writeSession(sql, runId, sessionId, {
        status: "succeeded",
        windowCount: outcome.windowCount,
        proposedCount: outcome.proposedCount,
        attempts: outcome.attempts,
        candidates: JSON.stringify(outcome.candidates.map(serializeCandidate)),
        dropped: JSON.stringify(countByReason(outcome.dropped)),
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
        costInr: outcome.usage.costInr,
        error: null,
      });
    },

    async saveFailure(runId, sessionId, message) {
      return writeSession(sql, runId, sessionId, {
        status: "failed",
        windowCount: null,
        proposedCount: null,
        attempts: null,
        candidates: "[]",
        dropped: "{}",
        inputTokens: null,
        outputTokens: null,
        costInr: null,
        error: message.slice(0, 500),
      });
    },

    async sessionStates(runId) {
      const rows = await sql<{ session_id: string | number; status: "succeeded" | "failed" }[]>`
        select session_id, status from extraction_session_results where run_id = ${runId}
      `;
      return new Map(rows.map((row) => [Number(row.session_id), row.status]));
    },

    async finalize(runId, build) {
      return sql.begin(async (tx) => {
        // FOR UPDATE waits for any session save that holds FOR SHARE, and blocks new ones.
        const [run] = await tx<{ status: RunStatus; session_count: number | null }[]>`
          select status, session_count from extraction_runs where id = ${runId} for update
        `;
        if (!run) throw new Error(`extraction run ${runId} does not exist`);
        if (run.status !== "running") return { status: "skipped", reason: `run is ${run.status}` } as const;

        const counts = await tx<{ status: string; n: number }[]>`
          select status, count(*)::int as n from extraction_session_results
          where run_id = ${runId} group by status
        `;
        const succeeded = num(counts.find((c) => c.status === "succeeded")?.n);
        const expected = num(run.session_count);
        if (succeeded !== expected) {
          return { status: "skipped", reason: `${succeeded} of ${expected} sessions are done` } as const;
        }

        const rows = await tx<{ session_id: string | number; window_count: number; candidates: CandidateJson[] | string }[]>`
          select session_id, window_count, candidates from extraction_session_results
          where run_id = ${runId} and status = 'succeeded' order by session_id
        `;
        const sessions: SessionCandidates[] = rows.map((row) => ({
          sessionId: Number(row.session_id),
          windows: num(row.window_count),
          candidates: candidatesOf(row.candidates).map(deserializeCandidate),
        }));

        const events = await build(sessions);
        for (const event of events) {
          const [inserted] = await tx<{ id: string | number }[]>`
            insert into events (
              title, summary, category, occurred_at, date_precision, ended_at, significance,
              is_first, first_of, first_check, speaker_id, quote, status, extraction_run_id
            ) values (
              ${event.title}, ${event.summary}, ${event.category}, ${event.occurredAt},
              ${event.datePrecision}::date_precision, ${event.endedAt}, ${event.significance},
              ${event.isFirst}, ${event.firstOf}, ${event.firstCheck}::text,
              ${event.speakerId}, ${event.quote}, 'draft'::event_status, ${runId}
            )
            returning id
          `;
          const eventId = Number(inserted?.id);
          for (const entry of event.evidence) {
            await tx`
              insert into event_evidence (event_id, message_id, role)
              values (${eventId}, ${entry.messageId}, ${entry.role}::evidence_role)
            `;
          }
        }

        await tx`
          update extraction_runs set status = 'succeeded', finished_at = now() where id = ${runId}
        `;
        return { status: "finalized", events: events.length } as const;
      }) as Promise<FinalizeResult>;
    },

    async runTotals(runId) {
      const [row] = await sql<
        { sessions: number; input_tokens: number | null; output_tokens: number | null; cost_inr: string | null; unpriced: number }[]
      >`
        select
          count(*)::int as sessions,
          sum(input_tokens)::int as input_tokens,
          sum(output_tokens)::int as output_tokens,
          sum(cost_inr)::text as cost_inr,
          count(*) filter (where cost_inr is null)::int as unpriced
        from extraction_session_results
        where run_id = ${runId} and status = 'succeeded'
      `;
      return {
        sessions: num(row?.sessions),
        inputTokens: num(row?.input_tokens),
        outputTokens: num(row?.output_tokens),
        // Null when any session had no price, so the total is never an undercount.
        costInr: num(row?.unpriced) > 0 ? null : nullableNum(row?.cost_inr) ?? 0,
      };
    },

    async latestFinalizedRunId() {
      const [row] = await sql<{ id: string | number }[]>`
        select id from extraction_runs where status = 'succeeded' order by id desc limit 1
      `;
      return row ? Number(row.id) : null;
    },

    async runEvents(runId) {
      const events = await sql<
        {
          id: string | number;
          title: string;
          summary: string;
          category: string;
          occurred_at: Date | string;
          date_precision: DatePrecision;
          ended_at: Date | string | null;
          significance: number;
          is_first: boolean;
          first_check: FirstCheck | null;
          status: EventStatus;
          on_timeline: boolean;
          speaker_id: PersonId | null;
          quote: string | null;
        }[]
      >`
        select id, title, summary, category, occurred_at, date_precision, ended_at, significance,
               is_first, first_check, status, on_timeline, speaker_id, quote
        from events where extraction_run_id = ${runId}
        order by occurred_at, id
      `;
      if (events.length === 0) return [];

      // Bun turns a JS array into "1,2,3". Postgres array syntax is "{1,2,3}", so split the text instead.
      const ids = events.map((event) => Number(event.id)).join(",");
      const evidence = await sql<
        {
          event_id: string | number;
          message_id: string | number;
          role: EvidenceRole;
          person_id: PersonId;
          sent_at: Date | string;
          source: MessageSource;
          text: string;
        }[]
      >`
        select ee.event_id, ee.message_id, ee.role, m.person_id, m.sent_at, m.source, m."text"
        from event_evidence ee
        join messages m on m.id = ee.message_id
        where ee.event_id = any (string_to_array(${ids}, ',')::bigint[])
        order by m.sent_at, m.id
      `;

      return events.map((event): ReviewEvent => {
        const id = Number(event.id);
        return {
          id,
          category: event.category,
          title: event.title,
          summary: event.summary,
          occurredAt: toDate(event.occurred_at),
          datePrecision: event.date_precision,
          endedAt: event.ended_at === null ? null : toDate(event.ended_at),
          significance: num(event.significance),
          isFirst: event.is_first,
          firstCheck: event.first_check,
          status: event.status,
          onTimeline: event.on_timeline,
          saying:
            event.speaker_id && event.quote !== null ? { personId: event.speaker_id, quote: event.quote } : null,
          evidence: evidence
            .filter((row) => Number(row.event_id) === id)
            .map((row) => ({
              messageId: Number(row.message_id),
              role: row.role,
              personId: row.person_id,
              sentAt: toDate(row.sent_at),
              source: row.source,
              text: row.text,
            })),
        };
      });
    },

    async applyReview(runId, updates, current) {
      const byId = new Map(current.map((event) => [event.id, event]));
      return sql.begin(async (tx) => {
        let applied = 0;
        for (const update of updates) {
          const before = byId.get(update.id);
          if (!before) throw new Error(`event ${update.id} is not in run ${runId}`);
          const next = mergeForUpdate(before, update);
          const rows = await tx`
            update events set
              status = ${next.status}::event_status,
              title = ${next.title},
              summary = ${next.summary},
              category = ${next.category},
              occurred_at = ${next.occurredAt},
              date_precision = ${next.datePrecision}::date_precision,
              ended_at = ${next.endedAt},
              significance = ${next.significance},
              is_first = ${next.isFirst},
              first_check = ${next.firstCheck}::text,
              speaker_id = ${next.speakerId},
              quote = ${next.quote},
              on_timeline = ${next.onTimeline}
            where id = ${update.id} and extraction_run_id = ${runId}
            returning id
          `;
          if (rows.length !== 1) throw new Error(`event ${update.id} could not be updated`);
          applied++;
        }
        return applied;
      }) as Promise<number>;
    },
  };
}

type SessionWrite = {
  status: "succeeded" | "failed";
  windowCount: number | null;
  proposedCount: number | null;
  attempts: number | null;
  candidates: string;
  dropped: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costInr: number | null;
  error: string | null;
};

/** Writes one session row. Holds FOR SHARE on the run so finalize cannot run in between. */
async function writeSession(sql: SQL, runId: number, sessionId: number, row: SessionWrite): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [run] = await tx<{ status: RunStatus }[]>`
      select status from extraction_runs where id = ${runId} for share
    `;
    if (!run) throw new Error(`extraction run ${runId} does not exist`);
    if (run.status !== "running") return false;

    await tx`
      insert into extraction_session_results (
        run_id, session_id, status, window_count, proposed_count, attempts, candidates, dropped,
        input_tokens, output_tokens, cost_inr, error, started_at, finished_at
      ) values (
        ${runId}, ${sessionId}, ${row.status}::run_status, ${row.windowCount}, ${row.proposedCount},
        ${row.attempts}, ${row.candidates}::text::jsonb, ${row.dropped}::text::jsonb, ${row.inputTokens},
        ${row.outputTokens}, ${row.costInr}, ${row.error}, now(), now()
      )
      on conflict (run_id, session_id) do update set
        status = excluded.status,
        window_count = excluded.window_count,
        proposed_count = excluded.proposed_count,
        attempts = excluded.attempts,
        candidates = excluded.candidates,
        dropped = excluded.dropped,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cost_inr = excluded.cost_inr,
        error = excluded.error,
        finished_at = now()
    `;
    return true;
  }) as Promise<boolean>;
}

function countByReason(dropped: readonly Dropped[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { reason } of dropped) counts[reason] = (counts[reason] ?? 0) + 1;
  return counts;
}

/** The row the review import writes: the current event with the reviewer's changes applied. */
export function mergeForUpdate(
  before: ReviewEvent,
  update: ReviewUpdate,
): {
  status: EventStatus;
  title: string;
  summary: string;
  category: string;
  occurredAt: Date;
  datePrecision: DatePrecision;
  endedAt: Date | null;
  significance: number;
  isFirst: boolean;
  firstCheck: FirstCheck | null;
  speakerId: PersonId | null;
  quote: string | null;
  onTimeline: boolean;
} {
  const c = update.changes;
  const isFirst = c.isFirst ?? before.isFirst;
  // The database only accepts is_first when verified. A reviewer's "yes" is a human check.
  // Clearing a verified first keeps the history visible as unverified.
  let firstCheck = before.firstCheck;
  if (isFirst) firstCheck = "verified";
  else if (before.firstCheck === "verified") firstCheck = "unverified";

  const saying = c.saying !== undefined ? c.saying : before.saying;
  return {
    status: update.status,
    title: c.title ?? before.title,
    summary: c.summary ?? before.summary,
    category: c.category ?? before.category,
    occurredAt: c.occurredAt ?? before.occurredAt,
    datePrecision: c.datePrecision ?? before.datePrecision,
    endedAt: c.endedAt !== undefined ? c.endedAt : before.endedAt,
    significance: c.significance ?? before.significance,
    isFirst,
    firstCheck,
    speakerId: saying ? saying.personId : null,
    quote: saying ? saying.quote : null,
    onTimeline: c.onTimeline ?? before.onTimeline,
  };
}

