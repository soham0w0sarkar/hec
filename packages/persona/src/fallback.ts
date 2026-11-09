import type { AnswerPayload } from "@hec/core";
import { composeSpoken } from "./receipts";

/**
 * Plain but still in-character rendering used when the model fails the fact check twice.
 * It keeps the voice and the receipts; it never adds a fact.
 */
export function voiceFallbackText(payload: AnswerPayload): string {
  return composeSpoken(fallbackLead(payload), payload);
}

export function fallbackLead(payload: AnswerPayload): string {
  if (payload.sensitivity === "heavy") {
    if (payload.verdict === "not_found") {
      return "I looked, and I couldn't find a record of that. I'd rather say so plainly than fill in the gap.";
    }
    if (payload.verdict === "ambiguous") return "The record doesn't settle it, so it's unclear.";
    if (payload.verdict === "partial") return "I found only part of it, so this is partial.";
    return "Here is what I found in the record.";
  }
  if (payload.verdict === "not_found") {
    return "I checked the story for that one, and I couldn't find it. I'd rather leave the gap than invent it.";
  }
  if (payload.verdict === "ambiguous") {
    return "The records don't agree, so it's unclear. I won't pretend there is one clean answer.";
  }
  if (payload.verdict === "partial") return "I only found part of it, so this is partial.";
  return "Here is what I found in the story.";
}
