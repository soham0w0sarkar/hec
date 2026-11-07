import {
  MESSAGE_KINDS,
  MESSAGE_SOURCES,
  PERSON_IDS,
  type MessageKind,
  type MessageSource,
  type PersonId,
} from "@hec/core";
import type { FoldForm, MessageHit } from "./types";

export type MessageRow = {
  id: string | number;
  person_id: string;
  name: string;
  sent_at: Date | string;
  sent_at_ist: string;
  text: string;
  source: string;
  source_ref: string;
  kind: string;
  session_id: string | number | null;
};

export const MESSAGE_COLUMNS = `
  m.id, m.person_id, p.name, m.sent_at,
  format_display_time(m.sent_at) as sent_at_ist,
  m."text", m.source, m.source_ref, m.kind, m.session_id`;

export function toMessageHit(row: MessageRow): MessageHit {
  const sentAt = row.sent_at instanceof Date ? row.sent_at : new Date(row.sent_at);
  if (Number.isNaN(sentAt.getTime())) throw new Error(`bad sent_at for message ${row.id}`);
  return {
    id: asId(row.id),
    personId: known(PERSON_IDS, row.person_id, "person"),
    name: row.name,
    sentAt,
    sentAtIst: row.sent_at_ist,
    text: row.text,
    source: known(MESSAGE_SOURCES, row.source, "source"),
    sourceRef: row.source_ref,
    kind: known(MESSAGE_KINDS, row.kind, "kind"),
    sessionId: row.session_id === null ? null : asId(row.session_id),
  };
}

export function known<T extends string>(allowed: readonly T[], value: string, label: string): T {
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`unknown ${label} from the database`);
  return value as T;
}

export function asId(value: string | number): number {
  const id = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(id)) throw new Error("id from the database is out of range");
  return id;
}

export function asForm(value: string): FoldForm {
  if (value !== "two" && value !== "one") throw new Error("match form from the database is not two or one");
  return value;
}

export function asCount(value: unknown): number {
  const count = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(count)) throw new Error("count from the database is out of range");
  return count;
}
