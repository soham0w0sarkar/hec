import type { AnswerPayload } from "@hec/core";

/**
 * Structured claim and caveat lines appended after a persona lead.
 * The model never writes these; that is what keeps long quotes from killing the voice.
 */
export function receipts(payload: AnswerPayload): string {
  const lines: string[] = [];
  for (const claim of payload.claims) {
    const who = [claim.date, claim.person, claim.source ? `on ${claim.source}` : null].filter(Boolean).join(" ");
    const ids = claim.message_ids.map((id) => `(#${id})`).join(", ");
    const text = claim.text.replace(/\.+$/, "");
    lines.push(["-", who, text].filter((part) => part.length > 0).join(" ") + ".");
    if (claim.quote) lines.push(`Quote: ${claim.quote}`);
    if (ids) lines.push(`Messages: ${ids}.`);
  }
  for (const caveat of payload.caveats) lines.push(caveat);
  if (payload.verdict === "not_found" && lines.length === 0) lines.push("Nothing matched the search.");
  return lines.join("\n");
}

/** Voice lead plus receipts. Empty lead falls back to interpretation + verdict. */
export function composeSpoken(lead: string, payload: AnswerPayload): string {
  const voice = lead.trim();
  const body = receipts(payload);
  if (!voice) {
    return [`${payload.interpretation_note}`, "", `Verdict: ${payload.verdict}. Confidence: ${payload.confidence}.`, body]
      .filter((line, index, all) => line.length > 0 || (index > 0 && all[index - 1]!.length > 0))
      .join("\n")
      .trim();
  }
  if (!body) return voice;
  return `${voice}\n\n${body}`;
}
