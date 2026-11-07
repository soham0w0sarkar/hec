import type { AnswerPayload } from "@hec/core";
import type { Ledger, LedgerMessage } from "./ledger";

const PET =
  /\b(baby seal|meow meow|kuchupuchu+|pookie|piddu|shona|jaanu|babu|bhondu|penguin)\b/i;

/**
 * When a nickname question still comes back not_found after starter searches already
 * put addressing lines in the ledger, rebuild a found answer from those messages.
 */
export function rescueNicknameAnswer(
  ledger: Ledger,
  people: readonly { id: string; name: string }[],
): AnswerPayload | null {
  const hits = [...ledger.messages.values()].filter((message) => !message.intimate && PET.test(message.text));
  if (hits.length === 0) return null;

  const nameOf = new Map(people.map((person) => [person.id, person.name]));
  const bySpeaker = new Map<string, LedgerMessage>();
  for (const message of hits) {
    const key = `${message.personId}:${petLabel(message.text) ?? "pet"}`;
    const prior = bySpeaker.get(key);
    if (!prior || message.sentAt < prior.sentAt) bySpeaker.set(key, message);
  }

  const claims = [...bySpeaker.values()].slice(0, 6).map((message) => {
    const label = petLabel(message.text) ?? "a pet name";
    const speaker = message.name;
    const otherId = message.personId === "person_1" ? "person_2" : "person_1";
    const other = nameOf.get(otherId) ?? otherId;
    return {
      text: `${speaker} addresses ${other} as ${label}.`,
      message_ids: [message.id],
      date: message.sentAtIst.slice(0, 10),
      person: speaker,
      source: message.source,
      quote: quoteAround(message.text, label),
      basis: "messages" as const,
    };
  });

  if (claims.length === 0) return null;
  return {
    version: 1,
    question_type: "what_did_we_say",
    verdict: "found",
    interpretation_note: "Pet names taken from messages where one person addresses the other.",
    claims,
    searched: { tools: ledger.tools.slice(0, 40), variants: ledger.variants.slice(0, 32), date_ranges: [] },
    caveats: ["Rebuilt from starter nickname searches after the draft answer dropped the quotes."],
    confidence: claims.length >= 2 ? "medium" : "low",
    sensitivity: "none",
  };
}

function petLabel(text: string): string | null {
  const match = PET.exec(text);
  return match?.[1]?.toLowerCase() ?? null;
}

function quoteAround(text: string, label: string): string | null {
  const index = text.toLowerCase().indexOf(label.toLowerCase());
  if (index < 0) return text.length <= 200 ? text : null;
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + label.length + 40);
  const slice = text.slice(start, end).trim();
  return slice.length <= 200 ? slice : text.slice(index, index + label.length);
}
