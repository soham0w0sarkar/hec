import type { AnswerPayload } from "@hec/core";

/** Plain rendering. No model. This is the fallback when a persona fails the fact check twice. */
export function neutralText(payload: AnswerPayload): string {
  const lines = [payload.interpretation_note, "", `Verdict: ${payload.verdict}. Confidence: ${payload.confidence}.`];
  for (const claim of payload.claims) {
    const who = [claim.date, claim.person, claim.source ? `on ${claim.source}` : null].filter(Boolean).join(" ");
    const ids = claim.message_ids.map((id) => `(#${id})`).join(", ");
    lines.push(["-", who, claim.text].filter((part) => part.length > 0).join(" ") + ".");
    if (claim.quote) lines.push(`Quote: ${claim.quote}`);
    if (ids) lines.push(`Messages: ${ids}.`);
  }
  for (const caveat of payload.caveats) lines.push(caveat);
  if (payload.verdict === "not_found") lines.push("Nothing matched the search.");
  return lines.join("\n");
}
