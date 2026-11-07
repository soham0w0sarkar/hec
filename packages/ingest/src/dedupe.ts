import type { MessageSource, PersonId } from "@hec/core";

/**
 * Same person, same text, within this window: the incoming copy is skipped.
 * A second export of the same chat is the usual case. Repeats that are not already stored are kept,
 * so a burst of "image omitted" inside one file still lands as several lines.
 * Files are ingested in no fixed order and stored messages are never deleted, so the copy stored first wins.
 */
export const DEDUPE_WINDOW_MS = 5 * 60 * 1000;

export type DedupeRow = {
  personId: PersonId;
  source: MessageSource;
  text: string;
  sentAt: Date;
};

export function dedupeText(text: string): string {
  return text.trim();
}

export function withoutDuplicates<T extends DedupeRow>(incoming: T[], stored: DedupeRow[]): T[] {
  const storedByKey = new Map<string, { source: MessageSource; sentAtMs: number }[]>();
  for (const row of stored) {
    const text = dedupeText(row.text);
    if (text === "") continue;
    const key = dedupeKey(row.personId, text);
    const rows = storedByKey.get(key) ?? [];
    rows.push({ source: row.source, sentAtMs: row.sentAt.getTime() });
    storedByKey.set(key, rows);
  }

  return incoming.filter((message) => {
    const text = dedupeText(message.text);
    if (text === "") return true;
    const candidates = storedByKey.get(dedupeKey(message.personId, text));
    if (!candidates) return true;
    const sentAtMs = message.sentAt.getTime();
    return !candidates.some((row) => Math.abs(row.sentAtMs - sentAtMs) <= DEDUPE_WINDOW_MS);
  });
}

function dedupeKey(personId: PersonId, text: string): string {
  return `${personId}\u0000${text}`;
}
