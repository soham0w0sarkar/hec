import { markToolData } from "./protocol";
import { executeTool, type ToolEnv } from "./tools";

const NICKNAME_QUESTION =
  /\b(nick\s*names?|pet\s*names?|what\s+do\s+(i|we|they|you)\s+call|what\s+does\s+\w+\s+call|call\s+each\s+other|bula(ta|ti|te|unga|ungi)?|naam|instead\s+of)\b|jagah|bulata|bulati|address(?:es|ing)?\s+each/i;

/** True when the question is about names used instead of the real display names. */
export function isNicknameQuestion(question: string): boolean {
  return NICKNAME_QUESTION.test(question);
}

/**
 * Runs a small fixed set of searches before the model loop so nickname answers
 * are not lost to "love you" / "call" keyword dead ends.
 * Uses keyword_search (one query each) instead of find_first (five queries each).
 */
export async function bootstrapNickname(env: ToolEnv): Promise<{ blocks: string[]; toolCalls: number }> {
  const blocks: string[] = [];
  let toolCalls = 0;

  const saying = await executeTool("list_events", { category: "Saying", limit: 20 }, env);
  toolCalls += 1;
  blocks.push(markToolData("list_events", saying.body));

  const jokes = await executeTool("list_events", { category: "Running joke", limit: 10 }, env);
  toolCalls += 1;
  blocks.push(markToolData("list_events", jokes.body));

  const fromEvents = candidatesFromToolBody(saying.body).concat(candidatesFromToolBody(jokes.body));
  const seeds = unique([...fromEvents, "Good morning my", "Good night my", "my baby seal", "meow meow"]).slice(0, 6);

  for (const text of seeds) {
    const outcome = await executeTool(
      "keyword_search",
      { text, mode: "phrase", limit: 5 },
      env,
    );
    toolCalls += 1;
    blocks.push(markToolData("keyword_search", outcome.body));
  }

  const spotted = unique([...fromEvents, ...seeds.filter((seed) => !/^Good /i.test(seed))]);
  if (spotted.length > 0) {
    blocks.push(
      markToolData("nickname_seeds", {
        note: "Pet-name phrases already seen in starter results. For each, cite who addresses whom.",
        phrases: spotted,
      }),
    );
  }

  return { blocks, toolCalls };
}

function candidatesFromToolBody(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const events = (body as { events?: unknown }).events;
  if (!Array.isArray(events)) return [];
  const found: string[] = [];
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const record = event as { title?: unknown; summary?: unknown; quote?: unknown };
    const blob = [record.quote, record.title, record.summary]
      .filter((part): part is string => typeof part === "string")
      .join(" ");
    // Only clear multi-word / known-style pet names — not every "my …" / "meri …".
    for (const match of blob.matchAll(/\b(baby seal|meow meow|kuchupuchu+|pookie|piddu|shona|jaanu|babu|penguin)\b/gi)) {
      if (match[1]) found.push(match[1]);
    }
    for (const match of blob.matchAll(/\b(?:Good (?:morning|night),?\s+my\s+)([A-Za-z][A-Za-z]*(?:\s+[A-Za-z]+){0,2})/gi)) {
      const phrase = (match[1] ?? "").trim();
      if (phrase.length >= 3 && phrase.length <= 30) found.push(phrase);
    }
  }
  return found;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value.trim());
  }
  return out;
}
