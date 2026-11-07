import { RetrievalError, busiestDays, callCounts, getContextAround, listEvents, streaks, whoMessagesFirst } from "@hec/retrieval";
import { EVENT_CATEGORIES, type EventCategory } from "@hec/core";
import type { SQL } from "bun";
import type { ChatAnswer } from "./chat";
import type { ChatMemory } from "./memory";
import type { HistoryTurn } from "@hec/agent";

const MAX_QUESTION = 2000;

export type ApiDeps = {
  memory: ChatMemory;
  answer: (input: { question: string; history: readonly HistoryTurn[] }) => Promise<ChatAnswer>;
  sql: SQL;
};

export function createApi(deps: ApiDeps): { fetch(request: Request): Promise<Response> } {
  return {
    fetch(request: Request) {
      return route(deps, request);
    },
  };
}

async function route(deps: ApiDeps, request: Request): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === "GET" && url.pathname === "/api/health") return json({ ok: true });
    if (request.method === "POST" && url.pathname === "/api/chat") return chat(deps, request);
    if (request.method === "GET" && url.pathname === "/api/timeline") return timeline(deps, url);
    if (request.method === "GET" && url.pathname === "/api/context") return context(deps, url);
    if (request.method === "GET" && url.pathname === "/api/stats") return stats(deps);
    return json({ error: "Not found." }, 404);
  } catch (error) {
    if (error instanceof RetrievalError && error.code === "invalid_input") return json({ error: error.message }, 400);
    console.error(error instanceof Error ? error.name : "request failed");
    return json({ error: "The request could not be completed." }, 500);
  }
}

async function chat(deps: ApiDeps, request: Request): Promise<Response> {
  const body = await readJson(request);
  if (!body.ok) return json({ error: "The body must be JSON." }, 400);
  const question = typeof body.value.question === "string" ? body.value.question.trim() : "";
  if (!question) return json({ error: "Ask a question." }, 400);
  if (question.length > MAX_QUESTION) return json({ error: "That question is too long." }, 400);
  const requested = typeof body.value.conversationId === "string" ? body.value.conversationId : "";
  const conversationId = isUuid(requested) ? requested : crypto.randomUUID();
  const history = await deps.memory.load(conversationId).catch(() => [] as HistoryTurn[]);
  let answer: ChatAnswer;
  try {
    answer = await deps.answer({ question, history });
  } catch (error) {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : "answer failed");
    return json({ error: "The answer could not be completed." }, 502);
  }
  await deps.memory
    .append(conversationId, [
      { role: "user", content: question },
      { role: "assistant", content: answer.text },
    ])
    .catch(() => undefined);
  return json({ conversationId, ...answer });
}

async function timeline(deps: ApiDeps, url: URL): Promise<Response> {
  const category = url.searchParams.get("category");
  if (category && !EVENT_CATEGORIES.includes(category as EventCategory)) {
    return json({ error: "Unknown category." }, 400);
  }
  const limit = numberParam(url, "limit") ?? 20;
  const page = await listEvents(deps.sql, {
    category: (category as EventCategory | null) ?? undefined,
    limit,
    after: url.searchParams.get("cursor") ?? undefined,
    onTimelineOnly: true,
  });
  return json({
    events: page.events.map((event) => ({
      id: event.id,
      title: event.title,
      summary: event.summary,
      category: event.category,
      occurredAtIst: event.occurredAtIst,
      datePrecision: event.datePrecision,
      significance: event.significance,
      quote: event.quote,
      evidenceMessageIds: event.evidenceMessageIds,
    })),
    next: page.next,
  });
}

async function context(deps: ApiDeps, url: URL): Promise<Response> {
  const messageId = Number(url.searchParams.get("messageId"));
  if (!Number.isSafeInteger(messageId) || messageId < 1) return json({ error: "Missing message." }, 400);
  const found = await getContextAround(deps.sql, messageId, 3, 8);
  return json({
    messages: found.messages.map((message) => ({
      id: message.id,
      name: message.name,
      sentAtIst: message.sentAtIst,
      source: message.source,
      kind: message.kind,
      text: message.text,
    })),
  });
}

async function stats(deps: ApiDeps): Promise<Response> {
  const [streak, busy, first, calls, people] = await Promise.all([
    streaks(deps.sql),
    busiestDays(deps.sql, { limit: 5 }),
    whoMessagesFirst(deps.sql),
    callCounts(deps.sql),
    deps.sql`select id, name from people` as Promise<{ id: string; name: string }[]>,
  ]);
  const names = new Map(people.map((person) => [person.id, person.name]));
  return json({
    streaks: streak,
    busiestDays: busy.days,
    whoMessagesFirst: first.days.map((row) => ({ name: names.get(row.personId) ?? row.personId, days: row.days })),
    calls: calls.calls,
    messages: calls.messages,
  });
}

function numberParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) ? value : undefined;
}

async function readJson(request: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  try {
    const value = (await request.json()) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
