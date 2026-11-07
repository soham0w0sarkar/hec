// In-memory ExtractionStore for tests. It follows the same rules as the SQL store: a run is open
// until finalized, a save into a closed run is refused, finalize needs every session succeeded,
// and session results pass through the same serialize/deserialize step the database uses.
import type { PersonId } from "@hec/core";
import type { SessionCandidates } from "./merge";
import type { FinalEvent } from "./pipeline";
import {
  deserializeCandidate,
  mergeForUpdate,
  serializeCandidate,
  type ExtractionStore,
  type FinalizeResult,
  type RunRow,
  type SessionOutcome,
  type SessionStates,
} from "./store";
import type { ReviewEvent, ReviewUpdate } from "./review";
import type { ExtractionMessage, SpeakerLabels } from "./types";

type StoredResult = {
  status: "succeeded" | "failed";
  windowCount: number;
  candidates: ReturnType<typeof serializeCandidate>[];
  usage: SessionOutcome["usage"] | null;
  error: string | null;
};

type StoredEvent = FinalEvent & {
  id: number;
  status: ReviewEvent["status"];
  runId: number;
  onTimeline: boolean;
};

export type MemoryStore = ExtractionStore & {
  runs: Map<number, RunRow & { finishedAt: boolean }>;
  events: StoredEvent[];
  failures: { runId: number; sessionId: number; message: string }[];
  results: Map<string, StoredResult>;
};

export function memoryStore(options: {
  labels: SpeakerLabels;
  sessions: Record<number, ExtractionMessage[]>;
}): MemoryStore {
  const runs = new Map<number, RunRow & { finishedAt: boolean }>();
  const results = new Map<string, StoredResult>();
  const events: StoredEvent[] = [];
  const failures: MemoryStore["failures"] = [];
  let nextRun = 1;
  let nextEvent = 1;
  const key = (runId: number, sessionId: number) => `${runId}:${sessionId}`;
  const messageById = new Map<number, ExtractionMessage>();
  for (const list of Object.values(options.sessions)) for (const m of list) messageById.set(m.id, m);

  const sessionStates = (runId: number): SessionStates => {
    const states: SessionStates = new Map();
    for (const [id, result] of results) {
      const [run, session] = id.split(":").map(Number);
      if (run === runId) states.set(session as number, result.status);
    }
    return states;
  };

  const store: MemoryStore = {
    runs,
    events,
    failures,
    results,

    async speakerLabels() {
      return options.labels;
    },
    async sessionIds() {
      return Object.keys(options.sessions)
        .map(Number)
        .sort((a, b) => a - b);
    },
    async sessionMessages(sessionId) {
      const list = options.sessions[sessionId];
      return list ? [...list] : null;
    },

    async createRun(input) {
      const id = nextRun++;
      runs.set(id, { id, status: "running", model: input.model, promptVersion: input.promptVersion, sessionCount: input.sessionCount, finishedAt: false });
      return id;
    },
    async getRun(runId) {
      const run = runs.get(runId);
      if (!run) return null;
      const { finishedAt: _ignored, ...row } = run;
      return row;
    },

    async saveOutcome(runId, sessionId, outcome) {
      if (runs.get(runId)?.status !== "running") return false;
      results.set(key(runId, sessionId), {
        status: "succeeded",
        windowCount: outcome.windowCount,
        candidates: outcome.candidates.map(serializeCandidate),
        usage: outcome.usage,
        error: null,
      });
      return true;
    },
    async saveFailure(runId, sessionId, message) {
      if (runs.get(runId)?.status !== "running") return false;
      results.set(key(runId, sessionId), { status: "failed", windowCount: 0, candidates: [], usage: null, error: message });
      failures.push({ runId, sessionId, message });
      return true;
    },
    async sessionStates(runId) {
      return sessionStates(runId);
    },

    async finalize(runId, build): Promise<FinalizeResult> {
      const run = runs.get(runId);
      if (!run) throw new Error(`extraction run ${runId} does not exist`);
      if (run.status !== "running") return { status: "skipped", reason: `run is ${run.status}` };
      const states = sessionStates(runId);
      const succeeded = [...states.values()].filter((s) => s === "succeeded").length;
      if (succeeded !== run.sessionCount) {
        return { status: "skipped", reason: `${succeeded} of ${run.sessionCount} sessions are done` };
      }
      const sessions: SessionCandidates[] = [...states.entries()]
        .filter(([, state]) => state === "succeeded")
        .map(([sessionId]) => {
          const result = results.get(key(runId, sessionId))!;
          return {
            sessionId,
            windows: result.windowCount,
            candidates: result.candidates.map(deserializeCandidate),
          };
        })
        .sort((a, b) => a.sessionId - b.sessionId);

      const built = await build(sessions);
      for (const event of built) {
        events.push({ ...event, id: nextEvent++, status: "draft", runId, onTimeline: false });
      }
      run.status = "succeeded";
      run.finishedAt = true;
      return { status: "finalized", events: built.length };
    },

    async runTotals(runId) {
      const succeeded = [...results.entries()].filter(([id, r]) => id.startsWith(`${runId}:`) && r.status === "succeeded");
      const priced = succeeded.map(([, r]) => r.usage);
      const unpriced = priced.some((u) => u === null || u.costInr === null);
      return {
        sessions: succeeded.length,
        inputTokens: priced.reduce((sum, u) => sum + (u?.inputTokens ?? 0), 0),
        outputTokens: priced.reduce((sum, u) => sum + (u?.outputTokens ?? 0), 0),
        costInr: unpriced ? null : priced.reduce((sum, u) => sum + (u?.costInr ?? 0), 0),
      };
    },

    async latestFinalizedRunId() {
      const done = [...runs.values()].filter((r) => r.status === "succeeded").map((r) => r.id);
      return done.length === 0 ? null : Math.max(...done);
    },

    async runEvents(runId) {
      return events
        .filter((e) => e.runId === runId)
        .map((e): ReviewEvent => ({
          id: e.id,
          category: e.category,
          title: e.title,
          summary: e.summary,
          occurredAt: e.occurredAt,
          datePrecision: e.datePrecision,
          endedAt: e.endedAt,
          significance: e.significance,
          isFirst: e.isFirst,
          firstCheck: e.firstCheck,
          status: e.status,
          onTimeline: e.onTimeline,
          saying: e.speakerId && e.quote !== null ? { personId: e.speakerId as PersonId, quote: e.quote } : null,
          evidence: e.evidence.map((entry) => {
            const message = messageById.get(entry.messageId)!;
            return {
              messageId: entry.messageId,
              role: entry.role,
              personId: message.personId,
              sentAt: message.sentAt,
              source: message.source,
              text: message.text,
            };
          }),
        }));
    },

    async applyReview(runId, updates: ReviewUpdate[], current: readonly ReviewEvent[]) {
      const byId = new Map(current.map((e) => [e.id, e]));
      for (const update of updates) {
        const before = byId.get(update.id);
        const stored = events.find((e) => e.id === update.id && e.runId === runId);
        if (!before || !stored) throw new Error(`event ${update.id} is not in run ${runId}`);
        const next = mergeForUpdate(before, update);
        Object.assign(stored, {
          status: next.status,
          title: next.title,
          summary: next.summary,
          category: next.category,
          occurredAt: next.occurredAt,
          datePrecision: next.datePrecision,
          endedAt: next.endedAt,
          significance: next.significance,
          isFirst: next.isFirst,
          firstCheck: next.firstCheck,
          speakerId: next.speakerId,
          quote: next.quote,
          onTimeline: next.onTimeline,
        });
      }
      return updates.length;
    },
  };

  return store;
}
