import type { SQL } from "bun";
import type { z } from "zod";
import {
  MESSAGE_SOURCES,
  PERSON_IDS,
  type MessageKind,
  type MessageSource,
  type PersonId,
} from "@hec/core";
import { RetrievalError, type ChunkHit, type EventHit, type KeywordHit, type MessageHit } from "@hec/retrieval";
import {
  busiestDays,
  callCounts,
  countMatches,
  countsPerPeriod,
  findFirst,
  findLast,
  getContextAround,
  getDayTranscript,
  hybridSearch,
  listEvents,
  matchesPerPeriod,
  searchChunks,
  searchMessages,
  streaks,
  whoMessagesFirst,
} from "@hec/retrieval";
import type { Embedder } from "./embed";
import { collectFigures, rememberMessage, rememberTool, type Ledger, type LedgerMessage, type RankedLook } from "./ledger";
import { isIntimateText, questionWantsIntimate } from "./sensitive";
import { applySpokenKinds, isSaidFirstQuestion, messageSaysPhrase } from "./spoken";
import { TOOL_VARIANTS, isToolName, toolSchemas, type ToolName } from "./tool-schema";

const SPOKEN_KIND_TOOLS = new Set<ToolName>([
  "find_first",
  "find_last",
  "count_matches",
  "matches_per_period",
  "keyword_search",
  "hybrid_search",
]);

export type RetrievalPort = {
  findFirst: typeof findFirst;
  findLast: typeof findLast;
  countMatches: typeof countMatches;
  matchesPerPeriod: typeof matchesPerPeriod;
  searchMessages: typeof searchMessages;
  searchChunks: typeof searchChunks;
  hybridSearch: typeof hybridSearch;
  getContextAround: typeof getContextAround;
  getDayTranscript: typeof getDayTranscript;
  busiestDays: typeof busiestDays;
  streaks: typeof streaks;
  whoMessagesFirst: typeof whoMessagesFirst;
  callCounts: typeof callCounts;
  countsPerPeriod: typeof countsPerPeriod;
  listEvents: typeof listEvents;
};

export function retrievalPort(): RetrievalPort {
  return {
    findFirst,
    findLast,
    countMatches,
    matchesPerPeriod,
    searchMessages,
    searchChunks,
    hybridSearch,
    getContextAround,
    getDayTranscript,
    busiestDays,
    streaks,
    whoMessagesFirst,
    callCounts,
    countsPerPeriod,
    listEvents,
  };
}

/** What one tool call is allowed to see. `semanticError` sticks for the rest of the run. */
export type ToolEnv = {
  sql: SQL;
  port: RetrievalPort;
  embedder: Embedder | null;
  chunksModel: string | null;
  question: string;
  ledger: Ledger;
  timeoutMs: number;
  semanticError: string | null;
};

export type ToolOutcome = { count: number; body: unknown };

type Cited = {
  message_id: number;
  source: MessageSource;
  speaker: string;
  person_id: PersonId;
  sent_at_utc: string;
  sent_at_ist: string;
  kind: MessageKind;
  text: string;
};

type MatchInput = {
  text: string;
  mode: "phrase" | "any_word" | "fuzzy";
  variants?: string[];
  person_id?: PersonId;
  source?: MessageSource;
  from?: string;
  until?: string;
  kinds?: MessageKind[];
  limit?: number;
  runners_up?: number;
  period?: "day" | "week" | "month";
};

/**
 * Models often send more spelling variants than the cap. Keep the first unique ones instead of failing
 * the whole search. The result echoes the variants that were used, so the model can see the cut.
 */
export function capVariants(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const record = input as Record<string, unknown>;
  if (!Array.isArray(record.variants)) return input;
  const seen = new Set<string>();
  const variants: unknown[] = [];
  for (const item of record.variants) {
    if (typeof item !== "string") {
      variants.push(item);
      continue;
    }
    const trimmed = item.trim();
    const key = trimmed.toLowerCase();
    if (trimmed === "" || seen.has(key)) continue;
    seen.add(key);
    variants.push(trimmed);
    if (variants.length === TOOL_VARIANTS) break;
  }
  return { ...record, variants };
}

/**
 * Runs one tool. Bad input and retrieval failures come back as `{ error }` and do not throw.
 * The error string never includes message text. Intimate lines are kept on the ledger and left out of `body`.
 */
export async function executeTool(name: string, input: unknown, env: ToolEnv): Promise<ToolOutcome> {
  if (!isToolName(name)) return { count: 0, body: { error: "unknown tool" } };
  const capped = capVariants(input);
  const shaped =
    SPOKEN_KIND_TOOLS.has(name) && capped && typeof capped === "object"
      ? applySpokenKinds(env.question, capped as Record<string, unknown>)
      : capped;
  const parsed = toolSchemas[name].safeParse(shaped);
  if (!parsed.success) return { count: 0, body: { error: `invalid_input: ${issuePaths(parsed.error)}` } };
  const value = parsed.data as Record<string, unknown>;
  rememberTool(env.ledger, name, value);
  try {
    return await deadline(env.timeoutMs, dispatch(name, value, env));
  } catch (error) {
    if (isTimeout(error)) return { count: 0, body: { error: "tool timed out" } };
    if (error instanceof RetrievalError) {
      if (error.code === "model_mismatch") {
        env.semanticError = "semantic_search is off: the embedder model does not match the chunks' model";
        return { count: 0, body: { error: env.semanticError } };
      }
      return { count: 0, body: { error: error.code } };
    }
    return { count: 0, body: { error: "tool failed" } };
  }
}

async function dispatch(name: ToolName, input: Record<string, unknown>, env: ToolEnv): Promise<ToolOutcome> {
  switch (name) {
    case "find_first":
      return rankedTool(env, "findFirst", input as MatchInput);
    case "find_last":
      return rankedTool(env, "findLast", input as MatchInput);
    case "count_matches": {
      const result = await env.port.countMatches(env.sql, keywordOf(input as MatchInput), { timeoutMs: env.timeoutMs });
      collectFigures({ total: result.total }, env.ledger);
      return { count: 1, body: { mode: result.mode, total: result.total } };
    }
    case "matches_per_period": {
      const matchInput = input as MatchInput;
      const result = await env.port.matchesPerPeriod(
        env.sql,
        { ...keywordOf(matchInput), period: matchInput.period ?? "day" },
        { timeoutMs: env.timeoutMs },
      );
      collectFigures(result.periods, env.ledger);
      return { count: result.periods.length, body: result };
    }
    case "keyword_search": {
      const page = await env.port.searchMessages(env.sql, { ...keywordOf(input as MatchInput), limit: (input.limit as number) ?? 10 }, {
        timeoutMs: env.timeoutMs,
      });
      const published = publish(page.hits, env);
      return { count: published.visible.length, body: { total: page.total, hits: published.visible, next: page.next } };
    }
    case "semantic_search":
      return semantic(env, input, false);
    case "hybrid_search":
      return semantic(env, input, true);
    case "get_context_around": {
      const around = await env.port.getContextAround(
        env.sql,
        input.message_id as number,
        input.before as number,
        input.after as number,
        narrowFilters(input),
        { timeoutMs: env.timeoutMs },
      );
      const published = publish(around.messages, env);
      return { count: published.visible.length, body: { hits: published.visible } };
    }
    case "get_day_transcript": {
      const page = await env.port.getDayTranscript(
        env.sql,
        input.day as string,
        { ...narrowFilters(input), limit: (input.limit as number) ?? 40 },
        { timeoutMs: env.timeoutMs },
      );
      const published = publish(page.hits, env);
      return { count: published.visible.length, body: { day: input.day, hits: published.visible, next: page.next } };
    }
    case "get_stats":
      return stats(env, input);
    case "list_events":
      return events(env, input);
    default:
      return { count: 0, body: { error: "unknown tool" } };
  }
}

async function rankedTool(env: ToolEnv, which: "findFirst" | "findLast", input: MatchInput): Promise<ToolOutcome> {
  const base = keywordOf(input);
  const runnersUp = input.runners_up ?? 5;
  const options = { timeoutMs: env.timeoutMs };
  const phrases = [input.text, ...(input.variants ?? [])].map((item) => item.trim()).filter((item) => item.length > 0);
  const spokenOnly = isSaidFirstQuestion(env.question);

  const pick = async (extra: Record<string, unknown> = {}) => {
    let page = await env.port[which](env.sql, { ...base, runnersUp, ...extra }, options);
    if (!spokenOnly) return page;
    return firstSpokenRanked(env, which, { ...base, runnersUp, ...extra }, page, phrases, options);
  };

  const [main, ...rest] = await Promise.all([
    pick(),
    ...PERSON_IDS.map((personId) => pick({ personId, runnersUp: 0 })),
    ...MESSAGE_SOURCES.map((source) => pick({ source, runnersUp: 0 })),
  ]);
  const people = rest.slice(0, PERSON_IDS.length);
  const sources = rest.slice(PERSON_IDS.length);
  const publishedMain = publish([main.hit, ...main.runnersUp].filter((hit): hit is KeywordHit => hit !== null), env);
  const byPerson = PERSON_IDS.map((personId, index) => {
    const hit = people[index]?.hit ?? null;
    if (hit) publish([hit], env);
    return { person_id: personId, hit: hit && !isHidden(hit, env) ? cite(hit) : null };
  });
  const bySource = MESSAGE_SOURCES.map((source, index) => {
    const hit = sources[index]?.hit ?? null;
    if (hit) publish([hit], env);
    return { source, hit: hit && !isHidden(hit, env) ? cite(hit) : null };
  });
  const look: RankedLook = {
    tool: which === "findFirst" ? "find_first" : "find_last",
    hitId: main.hit?.id ?? null,
    runnerIds: main.runnersUp.map((hit) => hit.id),
    byPerson: byPerson.map((row) => ({ personId: row.person_id, hitId: row.hit?.message_id ?? null })),
    bySource: bySource.map((row) => ({ source: row.source, hitId: row.hit?.message_id ?? null })),
  };
  env.ledger.looks.push(look);
  const visibleHit = main.hit && !isHidden(main.hit, env) ? cite(main.hit) : null;
  return {
    count: publishedMain.visible.length + byPerson.filter((row) => row.hit).length,
    body: {
      mode: main.mode,
      total: main.total,
      hit: visibleHit,
      runners_up: main.runnersUp.filter((hit) => !isHidden(hit, env)).map(cite),
      by_person: byPerson,
      by_source: bySource,
      ...(spokenOnly ? { spoken_phrase_only: true } : {}),
    },
  };
}

type RankedPage = Awaited<ReturnType<RetrievalPort["findFirst"]>>;

/** Skip substring false positives (e.g. "who love you") for said-first questions. */
async function firstSpokenRanked(
  env: ToolEnv,
  which: "findFirst" | "findLast",
  query: Record<string, unknown>,
  initial: RankedPage,
  phrases: string[],
  options: { timeoutMs: number },
): Promise<RankedPage> {
  let page = initial;
  for (let attempt = 0; attempt < 8; attempt++) {
    const pool = [page.hit, ...page.runnersUp].filter((hit): hit is KeywordHit => hit !== null);
    const spoken = pool.filter((hit) => messageSaysPhrase(hit.text, phrases));
    if (spoken.length > 0) {
      const hit = spoken[0]!;
      const rest = [
        ...spoken.filter((item) => item.id !== hit.id),
        // Keep substring false-positives visible as data, but never as the winner.
        ...pool.filter((item) => !spoken.some((ok) => ok.id === item.id)),
      ];
      const limit = typeof query.runnersUp === "number" ? query.runnersUp : 5;
      return { ...page, hit, runnersUp: rest.slice(0, limit) };
    }
    const edge = which === "findFirst" ? page.hit ?? page.runnersUp.at(-1) : page.hit ?? page.runnersUp[0];
    if (!edge) return { ...page, hit: null, runnersUp: [] };
    const nextQuery =
      which === "findFirst"
        ? { ...query, from: new Date(edge.sentAt.getTime() + 1) }
        : { ...query, until: edge.sentAt };
    page = await env.port[which](env.sql, nextQuery as never, options);
  }
  return { ...page, hit: null, runnersUp: [] };
}

async function semantic(env: ToolEnv, input: Record<string, unknown>, hybrid: boolean): Promise<ToolOutcome> {
  const blocked = semanticBlock(env);
  if (blocked) return { count: 0, body: { error: blocked } };
  const embedder = env.embedder;
  if (!embedder) return { count: 0, body: { error: "semantic_search is off: no embedder is configured" } };
  const vector = await embedder.embed(input.text as string);
  if (hybrid) {
    const fused = await env.port.hybridSearch(
      env.sql,
      {
        ...keywordOf(input as MatchInput),
        vector,
        model: embedder.model,
        limit: (input.limit as number) ?? 10,
      },
      { timeoutMs: env.timeoutMs },
    );
    const messages = fused.hits.flatMap((hit) => (hit.message ? [hit.message] : []));
    const published = publish(messages, env);
    const chunks = fused.hits
      .filter((hit) => hit.chunk && !chunkHidden(hit.chunk, env))
      .map((hit) => chunkOf(hit.chunk as ChunkHit));
    return {
      count: published.visible.length,
      body: { hits: published.visible, chunks, via: fused.hits.map((hit) => hit.via) },
    };
  }
  const found = await env.port.searchChunks(
    env.sql,
    {
      vector,
      model: embedder.model,
      limit: (input.limit as number) ?? 10,
      ...rangeOf(input),
      personId: input.person_id as PersonId | undefined,
      source: input.source as MessageSource | undefined,
    },
    { timeoutMs: env.timeoutMs },
  );
  const visible = found.hits.filter((chunk) => !chunkHidden(chunk, env)).map(chunkOf);
  return { count: visible.length, body: { chunks: visible } };
}

function semanticBlock(env: ToolEnv): string | null {
  if (env.semanticError) return env.semanticError;
  if (!env.embedder) return "semantic_search is off: no embedder is configured";
  if (!env.chunksModel) return "semantic_search is off: the chunks' model is not configured";
  if (env.embedder.model !== env.chunksModel) {
    env.semanticError = `semantic_search is off: embedder model ${env.embedder.model} does not match the chunks' model ${env.chunksModel}`;
    return env.semanticError;
  }
  return null;
}

async function stats(env: ToolEnv, input: Record<string, unknown>): Promise<ToolOutcome> {
  const filters = {
    personId: input.person_id as PersonId | undefined,
    source: input.source as MessageSource | undefined,
    fromDay: input.from_day as string | undefined,
    untilDay: input.until_day as string | undefined,
  };
  const options = { timeoutMs: env.timeoutMs };
  const stat = input.stat as string;
  let body: unknown;
  if (stat === "busiest_days") body = await env.port.busiestDays(env.sql, { ...filters, limit: (input.limit as number) ?? 5 }, options);
  else if (stat === "streaks") body = await env.port.streaks(env.sql, filters, options);
  else if (stat === "who_messages_first") {
    body = await env.port.whoMessagesFirst(env.sql, { source: filters.source, fromDay: filters.fromDay, untilDay: filters.untilDay }, options);
  } else if (stat === "call_counts") body = await env.port.callCounts(env.sql, filters, options);
  else if (stat === "counts_per_period") {
    const period = input.period;
    if (period !== "day" && period !== "week" && period !== "month") {
      return { count: 0, body: { error: "invalid_input: period" } };
    }
    body = await env.port.countsPerPeriod(env.sql, { ...filters, period, limit: (input.limit as number) ?? 10 }, options);
  } else return { count: 0, body: { error: "unknown stat" } };
  collectFigures(body, env.ledger);
  return { count: 1, body: { stat, result: body } };
}

async function events(env: ToolEnv, input: Record<string, unknown>): Promise<ToolOutcome> {
  const page = await env.port.listEvents(
    env.sql,
    {
      category: input.category as EventHit["category"] | undefined,
      from: input.from ? new Date(input.from as string) : undefined,
      until: input.until ? new Date(input.until as string) : undefined,
      limit: (input.limit as number) ?? 20,
      after: input.after as string | undefined,
    },
    { timeoutMs: env.timeoutMs },
  );
  const asked = questionWantsIntimate(env.question);
  const visible = [];
  for (const event of page.events) {
    env.ledger.events.push({
      id: event.id,
      category: event.category,
      date: event.occurredAtIst.slice(0, 10),
      quote: event.quote,
      evidenceIds: event.evidenceMessageIds,
    });
    const hidden = !asked && [event.title, event.summary, event.quote ?? ""].some((text) => isIntimateText(text));
    if (hidden) continue;
    visible.push({
      event_id: event.id,
      title: event.title,
      summary: event.summary,
      category: event.category,
      occurred_at_utc: event.occurredAt.toISOString(),
      occurred_at_ist: event.occurredAtIst,
      date_precision: event.datePrecision,
      source_status: event.status,
      speaker_id: event.speakerId,
      quote: event.quote,
      evidence_message_ids: event.evidenceMessageIds,
      evidence_truncated: event.evidenceTruncated,
    });
  }
  return { count: visible.length, body: { events: visible, next: page.next } };
}

function publish(hits: readonly MessageHit[], env: ToolEnv): { visible: Cited[] } {
  const visible: Cited[] = [];
  for (const hit of hits) {
    rememberMessage(env.ledger, toLedger(hit, env));
    if (isHidden(hit, env)) continue;
    visible.push(cite(hit));
  }
  return { visible };
}

function isHidden(hit: MessageHit, env: ToolEnv): boolean {
  return isIntimateText(hit.text) && !questionWantsIntimate(env.question);
}

function chunkHidden(chunk: ChunkHit, env: ToolEnv): boolean {
  return isIntimateText(chunk.transcript) && !questionWantsIntimate(env.question);
}

function toLedger(hit: MessageHit, env: ToolEnv): LedgerMessage {
  return {
    id: hit.id,
    personId: hit.personId,
    name: hit.name,
    source: hit.source,
    sentAt: hit.sentAt.toISOString(),
    sentAtIst: hit.sentAtIst,
    text: hit.text,
    kind: hit.kind,
    intimate: isIntimateText(hit.text) && !questionWantsIntimate(env.question),
  };
}

function cite(hit: MessageHit): Cited {
  return {
    message_id: hit.id,
    source: hit.source,
    speaker: hit.name,
    person_id: hit.personId,
    sent_at_utc: hit.sentAt.toISOString(),
    sent_at_ist: hit.sentAtIst,
    kind: hit.kind,
    text: hit.text,
  };
}

function chunkOf(chunk: ChunkHit): unknown {
  return {
    chunk_id: chunk.id,
    first_message_id: chunk.firstMessageId,
    last_message_id: chunk.lastMessageId,
    from_utc: chunk.from.toISOString(),
    until_utc: chunk.until.toISOString(),
    from_ist: chunk.fromIst,
    until_ist: chunk.untilIst,
    score: chunk.score,
    transcript: chunk.transcript,
  };
}

function keywordOf(input: MatchInput) {
  return {
    text: input.text,
    mode: input.mode,
    variants: input.variants,
    ...narrowFilters(input),
    ...rangeOf(input),
    limit: input.limit,
  };
}

function narrowFilters(input: Record<string, unknown>) {
  return {
    personId: input.person_id as PersonId | undefined,
    source: input.source as MessageSource | undefined,
    kinds: input.kinds as MessageKind[] | undefined,
  };
}

function rangeOf(input: Record<string, unknown>) {
  return {
    from: typeof input.from === "string" ? new Date(input.from) : undefined,
    until: typeof input.until === "string" ? new Date(input.until) : undefined,
  };
}

function issuePaths(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => issue.path.join(".") || "input")
    .join(", ");
}

function isTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && "timeout" in error;
}

function deadline<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject({ timeout: true }), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
