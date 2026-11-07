import type { AnswerPayload } from "@hec/core";
import { composeSpoken } from "./receipts";

/** Plain rendering. No model. This is the fallback when a persona fails the fact check twice. */
export function neutralText(payload: AnswerPayload): string {
  return composeSpoken(
    `${payload.interpretation_note}\n\nVerdict: ${payload.verdict}. Confidence: ${payload.confidence}.`,
    payload,
  );
}
