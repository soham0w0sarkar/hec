import {
  DATE_PRECISIONS,
  DISPLAY_TIMEZONE,
  EVENT_STATUSES,
  type DatePrecision,
  type EventStatus,
  type EvidenceRole,
  type MessageSource,
  type PersonId,
} from "@hec/core";
import { isCategory } from "./categories";
import { formatLocal, parseLocal } from "./time";
import { collapseWhitespace, refOf } from "./transcript";
import { type EventCategory, type FirstCheck, type Significance, type SpeakerLabels } from "./types";
import { findQuote, sameName } from "./validate";

/** An event as the review file needs it: the row, plus the messages that prove it. */
export type ReviewEvent = {
  id: number;
  category: string;
  title: string;
  summary: string;
  occurredAt: Date;
  datePrecision: DatePrecision;
  endedAt: Date | null;
  significance: number;
  isFirst: boolean;
  firstCheck: FirstCheck | null;
  status: EventStatus;
  /** Shown on the timeline page. Chat ignores it. */
  onTimeline: boolean;
  saying: { personId: PersonId; quote: string } | null;
  evidence: {
    messageId: number;
    role: EvidenceRole;
    personId: PersonId;
    sentAt: Date;
    source: MessageSource;
    text: string;
  }[];
};

export type ReviewHeader = { runId: number; model: string; promptVersion: string; exportedAt: Date };

const SOURCE_TAG: Record<MessageSource, string> = { instagram: "ig", whatsapp: "wa" };
const EVIDENCE_PREVIEW_CHARS = 240;

const flat = (text: string) => collapseWhitespace(text);

/**
 * The review file. One block per event, oldest first. Edit the `key: value` lines you want to
 * change and set `status:`. The evidence lines are for reading and are ignored on import.
 * The file holds real message text, so it only belongs under data/review/ (git ignores that).
 */
export function renderReview(
  header: ReviewHeader,
  events: readonly ReviewEvent[],
  labels: SpeakerLabels,
  timeZone = DISPLAY_TIMEZONE,
): string {
  const sorted = [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id - b.id);
  const out: string[] = [
    "# HEC event review",
    "",
    `run: ${header.runId} | model: ${header.model} | prompt: ${header.promptVersion} | events: ${sorted.length} | exported: ${header.exportedAt.toISOString()}`,
    "",
    "How to review:",
    "- Set `status:` to approved, edited, or rejected. Leave `draft` to skip an event for now.",
    "- `status: approved` (or edited) is what chat uses. The timeline page only shows a row when status is approved/edited AND `timeline: yes`.",
    "- To fix an event, change any of: category, date, precision, ended, significance, first, title, summary, speaker, quote. Changing a field on an approved event makes it edited.",
    `- Dates are ${timeZone} as YYYY-MM-DD HH:mm (or YYYY-MM-DD, or YYYY-MM). Precision is ${DATE_PRECISIONS.join(", ")}. Use - for no end date.`,
    "- `timeline: yes` or `no`. Changing `timeline` does not count as an edit.",
    "- Lines under `evidence:` are read-only.",
    "",
  ];

  for (const event of sorted) {
    out.push("---", "", `## event ${event.id}`);
    out.push(`status: ${event.status}`);
    out.push(`category: ${event.category}`);
    out.push(`date: ${formatLocal(event.occurredAt, timeZone)}`);
    out.push(`precision: ${event.datePrecision}`);
    out.push(`ended: ${event.endedAt ? formatLocal(event.endedAt, timeZone) : "-"}`);
    out.push(`significance: ${event.significance}`);
    out.push(`first: ${event.isFirst ? "yes" : "no"}${event.firstCheck ? ` (${event.firstCheck})` : ""}`);
    out.push(`timeline: ${event.onTimeline ? "yes" : "no"}`);
    out.push(`title: ${flat(event.title)}`);
    out.push(`summary: ${flat(event.summary)}`);
    if (event.saying) {
      out.push(`speaker: ${labels[event.saying.personId]}`);
      out.push(`quote: ${flat(event.saying.quote)}`);
    }
    out.push("evidence:");
    for (const entry of event.evidence) {
      const text = flat(entry.text);
      const preview = text.length > EVIDENCE_PREVIEW_CHARS ? `${text.slice(0, EVIDENCE_PREVIEW_CHARS)}…` : text;
      out.push(
        `  [${refOf(entry.messageId)}] ${formatLocal(entry.sentAt, timeZone)} ${labels[entry.personId]} ${SOURCE_TAG[entry.source]} (${entry.role}): ${preview}`,
      );
    }
    out.push("");
  }
  return `${out.join("\n")}\n`;
}

/** What a reviewer wrote for one event: the raw text of each editable line. */
export type ParsedReviewEvent = { id: number; fields: Partial<Record<EditableKey, string>> };

const EDITABLE_KEYS = [
  "status",
  "category",
  "date",
  "precision",
  "ended",
  "significance",
  "first",
  "timeline",
  "title",
  "summary",
  "speaker",
  "quote",
] as const;
type EditableKey = (typeof EDITABLE_KEYS)[number];

export function parseReview(text: string): { events: ParsedReviewEvent[]; errors: string[] } {
  const events: ParsedReviewEvent[] = [];
  const errors: string[] = [];
  const seen = new Set<number>();

  const blocks = text.split(/^## event\s+/m).slice(1);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const id = Number((lines[0] ?? "").trim());
    if (!Number.isSafeInteger(id) || id < 1) {
      errors.push(`a block has no valid event id: "${(lines[0] ?? "").trim().slice(0, 20)}"`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`event ${id} appears twice`);
      continue;
    }
    seen.add(id);

    const fields: ParsedReviewEvent["fields"] = {};
    for (const line of lines.slice(1)) {
      if (line.startsWith("evidence:") || line.startsWith("---")) break;
      const match = /^([a-z]+):\s?(.*)$/.exec(line);
      if (!match) continue;
      const key = match[1] as EditableKey;
      if ((EDITABLE_KEYS as readonly string[]).includes(key)) fields[key] = (match[2] as string).trim();
    }
    events.push({ id, fields });
  }
  return { events, errors };
}

/** Replaces the `status:` line of one event block. Other lines, including evidence, stay as they are. */
export function setReviewStatus(
  text: string,
  id: number,
  status: EventStatus,
): { text: string; found: boolean } {
  const heading = new RegExp(`^## event ${id}$`, "m").exec(text);
  if (!heading) return { text, found: false };
  const lineStart = heading.index + heading[0].length + 1;
  const lineEnd = text.indexOf("\n", lineStart);
  const end = lineEnd === -1 ? text.length : lineEnd;
  if (!text.slice(lineStart, end).startsWith("status:")) return { text, found: false };
  return { text: `${text.slice(0, lineStart)}status: ${status}${text.slice(end)}`, found: true };
}

/** Sets `timeline:` inside one event block, adding the line under `status:` when an older export has none. */
export function setReviewTimeline(
  text: string,
  id: number,
  onTimeline: boolean,
): { text: string; found: boolean } {
  const heading = new RegExp(`^## event ${id}$`, "m").exec(text);
  if (!heading) return { text, found: false };
  const nextHeading = text.indexOf("\n## event ", heading.index + heading[0].length);
  const end = nextHeading === -1 ? text.length : nextHeading;
  const block = text.slice(heading.index, end);
  const value = onTimeline ? "yes" : "no";
  const line = /^timeline:.*$/m;
  const next = line.test(block)
    ? block.replace(line, `timeline: ${value}`)
    : block.replace(/^status:.*$/m, (status) => `${status}\ntimeline: ${value}`);
  if (next === block) return { text, found: false };
  return { text: `${text.slice(0, heading.index)}${next}${text.slice(end)}`, found: true };
}

export type ReviewChanges = {
  category?: EventCategory;
  occurredAt?: Date;
  datePrecision?: DatePrecision;
  endedAt?: Date | null;
  significance?: Significance;
  isFirst?: boolean;
  /** Timeline visibility only. Not a content edit, so it never turns an approved event into edited. */
  onTimeline?: boolean;
  title?: string;
  summary?: string;
  /** Set when the resulting category is Saying, null when it stops being one. */
  saying?: { personId: PersonId; quote: string } | null;
};

export type ReviewUpdate = {
  id: number;
  status: Exclude<EventStatus, "draft">;
  changes: ReviewChanges;
};

export type ReviewPlan = {
  updates: ReviewUpdate[];
  /** Still draft, or already in the state the file says. */
  unchanged: number;
  /** Problems with one event. That event is not updated; the others are. */
  problems: { id: number; problem: string }[];
};

/**
 * Turns the edited file into updates, without touching the database.
 *
 * - `status: draft` leaves the event alone.
 * - `rejected` only sets the status; edits on a rejected event are ignored.
 * - Edits on an `approved` event make it `edited`. `edited` with no edits stays `edited`.
 * - Edited values are checked. A Saying still needs a quote that is verbatim in an evidence
 *   message, said by the stated speaker. Dates are the reviewer's call, so they are not forced
 *   into the evidence range, but an end date must come after the start.
 */
export function planReviewImport(
  current: readonly ReviewEvent[],
  parsed: readonly ParsedReviewEvent[],
  labels: SpeakerLabels,
  timeZone = DISPLAY_TIMEZONE,
): ReviewPlan {
  const byId = new Map(current.map((event) => [event.id, event]));
  const plan: ReviewPlan = { updates: [], unchanged: 0, problems: [] };

  for (const entry of parsed) {
    const event = byId.get(entry.id);
    if (!event) {
      plan.problems.push({ id: entry.id, problem: "not in this run's drafts" });
      continue;
    }

    const rawStatus = (entry.fields.status ?? event.status).toLowerCase();
    if (!(EVENT_STATUSES as readonly string[]).includes(rawStatus)) {
      plan.problems.push({ id: entry.id, problem: `unknown status "${rawStatus.slice(0, 20)}"` });
      continue;
    }
    const status = rawStatus as EventStatus;
    if (status === "draft") {
      plan.unchanged++;
      continue;
    }

    const checked = status === "rejected" ? { ok: true as const, changes: {} } : diffFields(event, entry.fields, labels, timeZone);
    if (!checked.ok) {
      plan.problems.push({ id: entry.id, problem: checked.problem });
      continue;
    }

    // Timeline visibility is not a content edit, so it does not make an approved event "edited".
    const { onTimeline, ...content } = checked.changes;
    const edited = Object.keys(content).length > 0;
    const nextStatus: ReviewUpdate["status"] = status === "approved" && edited ? "edited" : status;
    if (nextStatus === event.status && !edited && onTimeline === undefined) {
      plan.unchanged++;
      continue;
    }
    plan.updates.push({ id: event.id, status: nextStatus, changes: checked.changes });
  }
  return plan;
}

type Diff = { ok: true; changes: ReviewChanges } | { ok: false; problem: string };

function diffFields(
  event: ReviewEvent,
  fields: ParsedReviewEvent["fields"],
  labels: SpeakerLabels,
  timeZone: string,
): Diff {
  const changes: ReviewChanges = {};

  let category = event.category;
  if (fields.category !== undefined && fields.category !== event.category) {
    if (!isCategory(fields.category)) return { ok: false, problem: "category is not one of the nine" };
    category = fields.category;
    changes.category = fields.category;
  }

  if (fields.title !== undefined && fields.title !== flat(event.title)) {
    if (fields.title === "") return { ok: false, problem: "title is empty" };
    changes.title = fields.title;
  }
  if (fields.summary !== undefined && fields.summary !== flat(event.summary)) {
    if (fields.summary === "") return { ok: false, problem: "summary is empty" };
    changes.summary = fields.summary;
  }

  if (fields.significance !== undefined && fields.significance !== String(event.significance)) {
    const value = Number(fields.significance);
    if (!Number.isInteger(value) || value < 1 || value > 3) return { ok: false, problem: "significance must be 1, 2 or 3" };
    changes.significance = value as Significance;
  }

  if (fields.precision !== undefined && fields.precision !== event.datePrecision) {
    if (!(DATE_PRECISIONS as readonly string[]).includes(fields.precision)) {
      return { ok: false, problem: `precision must be ${DATE_PRECISIONS.join(", ")}` };
    }
    changes.datePrecision = fields.precision as DatePrecision;
  }

  let occurredAt = event.occurredAt;
  if (fields.date !== undefined && fields.date !== formatLocal(event.occurredAt, timeZone)) {
    const parsed = parseLocal(fields.date, timeZone);
    if (!parsed) return { ok: false, problem: "date is not YYYY-MM-DD HH:mm, YYYY-MM-DD or YYYY-MM" };
    occurredAt = parsed.instant;
    changes.occurredAt = parsed.instant;
  }

  let endedAt = event.endedAt;
  const currentEnded = event.endedAt ? formatLocal(event.endedAt, timeZone) : "-";
  if (fields.ended !== undefined && (fields.ended === "" ? "-" : fields.ended) !== currentEnded) {
    if (fields.ended === "" || fields.ended === "-") {
      endedAt = null;
    } else {
      const parsed = parseLocal(fields.ended, timeZone);
      if (!parsed) return { ok: false, problem: "ended is not a valid date, or - for none" };
      endedAt = parsed.instant;
    }
    changes.endedAt = endedAt;
  }
  if (endedAt && endedAt.getTime() <= occurredAt.getTime()) return { ok: false, problem: "ended must be after date" };

  if (fields.first !== undefined) {
    const word = fields.first.toLowerCase().split(/\s+/)[0];
    if (word !== "yes" && word !== "no") return { ok: false, problem: "first must be yes or no" };
    if ((word === "yes") !== event.isFirst) changes.isFirst = word === "yes";
  }

  if (fields.timeline !== undefined) {
    const word = fields.timeline.toLowerCase().split(/\s+/)[0];
    if (word !== "yes" && word !== "no") return { ok: false, problem: "timeline must be yes or no" };
    if ((word === "yes") !== event.onTimeline) changes.onTimeline = word === "yes";
  }

  const saying = diffSaying(event, category, fields, labels);
  if (!saying.ok) return saying;
  if (saying.change !== undefined) changes.saying = saying.change;

  return { ok: true, changes };
}

function diffSaying(
  event: ReviewEvent,
  category: string,
  fields: ParsedReviewEvent["fields"],
  labels: SpeakerLabels,
): { ok: true; change?: ReviewChanges["saying"] } | { ok: false; problem: string } {
  if (category !== "Saying") return { ok: true, change: event.saying ? null : undefined };

  const currentSpeaker = event.saying ? labels[event.saying.personId] : "";
  const quote = fields.quote ?? event.saying?.quote ?? "";
  const speaker = fields.speaker ?? currentSpeaker;
  const unchanged = event.saying && quote === flat(event.saying.quote) && sameName(speaker, currentSpeaker);
  if (unchanged) return { ok: true };

  if (quote === "") return { ok: false, problem: "a Saying needs a quote" };
  if (speaker.trim() === "") return { ok: false, problem: "a Saying needs a speaker" };
  const source = findQuote(
    quote,
    event.evidence.map((entry) => ({ ...entry, id: entry.messageId, kind: "text" as const })),
  );
  if (!source) return { ok: false, problem: "quote is not word for word in an evidence message" };
  if (!sameName(labels[source.personId], speaker)) {
    return { ok: false, problem: "speaker did not send the quoted message" };
  }
  return { ok: true, change: { personId: source.personId, quote: flat(quote) } };
}
