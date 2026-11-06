import type { MessageKind, MessageSource } from "@hec/core";

/** A new session starts when the next message arrives after this much silence. */
export const SESSION_GAP_MS = 4 * 60 * 60 * 1000;

export type SessionMessage = {
  id: number;
  sentAt: Date;
  source: MessageSource;
  kind: MessageKind;
};

export type SessionDraft = {
  messageIds: number[];
  startedAt: Date;
  endedAt: Date;
  sources: MessageSource[];
};

export function buildSessions(messages: SessionMessage[], gapMs = SESSION_GAP_MS): SessionDraft[] {
  const timeline = messages
    .filter((message) => message.kind !== "system")
    .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime() || a.id - b.id);

  const sessions: SessionDraft[] = [];
  for (const message of timeline) {
    const current = sessions.at(-1);
    const gap = current ? message.sentAt.getTime() - current.endedAt.getTime() : 0;
    if (!current || gap > gapMs) {
      sessions.push({
        messageIds: [message.id],
        startedAt: message.sentAt,
        endedAt: message.sentAt,
        sources: [message.source],
      });
      continue;
    }

    current.messageIds.push(message.id);
    current.endedAt = message.sentAt;
    if (!current.sources.includes(message.source)) current.sources.push(message.source);
  }

  return sessions;
}
