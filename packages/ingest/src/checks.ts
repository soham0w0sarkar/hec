import { IngestError } from "./errors";
import type { ParsedMessage } from "./types";

const FUTURE_SLACK_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A backwards jump of a day or more means the date format was read wrong. */
export function assertNoLargeReversal(messages: ParsedMessage[], fileName: string): void {
  for (let i = 1; i < messages.length; i++) {
    const previous = messages[i - 1];
    const current = messages[i];
    if (!previous || !current) continue;
    const gap = previous.sentAt.getTime() - current.sentAt.getTime();
    if (gap > DAY_MS) {
      throw new IngestError(
        `${fileName}: ${current.sourceRef} jumps back more than a day. The date format may be wrong.`,
      );
    }
  }
}

/** Shorter inversions are kept. The export wrote one line out of order. */
export function smallReversals(messages: ParsedMessage[], fileName: string): string[] {
  const warnings: string[] = [];
  for (let i = 1; i < messages.length; i++) {
    const previous = messages[i - 1];
    const current = messages[i];
    if (!previous || !current) continue;
    const gap = previous.sentAt.getTime() - current.sentAt.getTime();
    if (gap <= 1000 || gap > DAY_MS) continue;
    warnings.push(
      `${fileName}: ${current.sourceRef} is ${Math.round(gap / 60_000)} min earlier than the previous line`,
    );
  }
  return warnings;
}

export function assertNotFuture(messages: ParsedMessage[], now: Date, fileName: string): void {
  const limit = now.getTime() + FUTURE_SLACK_MS;
  for (const message of messages) {
    if (message.sentAt.getTime() > limit) {
      throw new IngestError(`${fileName}: ${message.sourceRef} is in the future`);
    }
  }
}
