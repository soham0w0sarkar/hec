import type { ChatModel, ChatRequest } from "@hec/llm";

const usage = { inputTokens: 40, outputTokens: 30, cachedInputTokens: 0, costInr: 0 };

type ToolBody = { name: string; body: Record<string, unknown> };

/**
 * A stand-in for the model. It picks one tool from the case id, then copies ids, dates, and text
 * out of the tool result. It does not invent a message the tool did not return.
 */
export function planner(caseId: string): ChatModel {
  return {
    model: "planner",
    async complete(request: ChatRequest) {
      const blocks = toolBlocks(request.user);
      const text = blocks.length === 0 ? JSON.stringify(firstAction(caseId)) : JSON.stringify(answer(caseId, blocks));
      return { text, usage };
    },
  };
}

function firstAction(caseId: string): unknown {
  switch (caseId) {
    case "how-many-hellos":
      return { action: "tool", name: "count_matches", input: { text: "hello", mode: "phrase" } };
    case "first-call":
      return { action: "tool", name: "find_first", input: { text: "call", mode: "any_word", kinds: ["call"] } };
    case "picnic-plan":
      return { action: "tool", name: "keyword_search", input: { text: "picnic", mode: "phrase" } };
    case "not-found":
      return { action: "tool", name: "find_first", input: { text: "quantum platypus", mode: "phrase" } };
    case "ambiguous-goodnight":
      return { action: "tool", name: "find_first", input: { text: "goodnight", mode: "phrase" } };
    case "hinglish-variant":
      return { action: "tool", name: "find_first", input: { text: "pyaar", mode: "phrase", variants: ["pyar"] } };
    case "intimate-left-out":
      return { action: "tool", name: "get_day_transcript", input: { day: "2030-07-04" } };
    case "conflict-is-heavy":
      return { action: "tool", name: "list_events", input: { category: "Conflict" } };
    default:
      return { action: "tool", name: "find_first", input: { text: "hello", mode: "phrase" } };
  }
}

function answer(caseId: string, blocks: ToolBody[]): unknown {
  const block = blocks[0];
  if (!block) return notFound("No tool result.");
  if (caseId === "how-many-hellos") {
    const total = block.body.total;
    if (typeof total !== "number") return notFound("No count.");
    return found("count", [
      {
        text: `The phrase appears ${total} times.`,
        message_ids: [],
        date: null,
        person: null,
        source: null,
        quote: null,
        basis: "count",
      },
    ]);
  }
  if (caseId === "picnic-plan" || caseId === "intimate-left-out") {
    const hits = asHits(block.body.hits);
    if (hits.length === 0) return notFound("No messages on that search.");
    return found(
      caseId === "intimate-left-out" ? "on_this_date" : "what_did_we_say",
      hits.map(claimFor),
    );
  }
  if (caseId === "conflict-is-heavy") {
    const events = Array.isArray(block.body.events) ? block.body.events : [];
    const event = asRecord(events[0]);
    if (!event) return notFound("No reviewed event.");
    const date = typeof event.occurred_at_ist === "string" ? event.occurred_at_ist.slice(0, 10) : null;
    return {
      action: "answer",
      payload: {
        question_type: "timeline",
        verdict: "found",
        sensitivity: "none",
        confidence: "medium",
        interpretation_note: "The question asks about a fight, answered from reviewed events.",
        claims: [
          {
            text: "An argument is on the timeline.",
            message_ids: Array.isArray(event.evidence_message_ids) ? event.evidence_message_ids : [],
            date,
            person: null,
            source: null,
            quote: null,
            basis: "timeline",
          },
        ],
        caveats: [],
      },
    };
  }
  const hit = asRecord(block.body.hit);
  if (!hit) return notFound("No matching message.");
  return found(caseId === "first-call" ? "first_last" : "first_last", [claimFor(hit)]);
}

function claimFor(hit: Record<string, unknown>): unknown {
  const ist = typeof hit.sent_at_ist === "string" ? hit.sent_at_ist : "";
  return {
    text: `${String(hit.speaker)} sent a matching message.`,
    message_ids: [hit.message_id],
    date: ist.slice(0, 10),
    person: hit.speaker,
    source: hit.source,
    quote: hit.text,
    basis: "messages",
  };
}

function found(questionType: string, claims: unknown[]): unknown {
  return {
    action: "answer",
    payload: {
      question_type: questionType,
      verdict: "found",
      sensitivity: "none",
      confidence: "high",
      interpretation_note: "Answered from the first tool result.",
      claims,
      caveats: [],
    },
  };
}

function notFound(note: string): unknown {
  return {
    action: "answer",
    payload: {
      question_type: "other",
      verdict: "not_found",
      sensitivity: "none",
      confidence: "low",
      interpretation_note: note,
      claims: [],
      caveats: ["The search returned nothing."],
    },
  };
}

function toolBlocks(user: string): ToolBody[] {
  const blocks: ToolBody[] = [];
  const pattern = /<tool_data name="([^"]+)">\n([\s\S]*?)\n<\/tool_data>/g;
  for (const match of user.matchAll(pattern)) {
    const name = match[1];
    const raw = match[2];
    if (!name || !raw) continue;
    blocks.push({ name, body: JSON.parse(raw) as Record<string, unknown> });
  }
  return blocks;
}

function asHits(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    return record ? [record] : [];
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
