import type { EventStatus, MessageSource } from "@hec/core";
import type { ReviewEvent } from "./review";
import { formatLocal } from "./time";
import { collapseWhitespace, refOf } from "./transcript";
import type { SpeakerLabels } from "./types";

const SOURCE_TAG: Record<MessageSource, string> = { instagram: "ig", whatsapp: "wa" };
const LINE_WIDTH = 76;
const EVIDENCE_SHOWN = 4;
const EVIDENCE_CHARS = 240;
const LIST_COUNT = 15;

export const REVIEW_KEYS =
  "a approve    r reject    t timeline yes/no    enter next    p prev    l list    <id> jump    q quit    ? help";

/** The events this session will walk. `all` keeps every status; otherwise one status, oldest first. */
export function selectReviewEvents(events: readonly ReviewEvent[], status: EventStatus | "all"): ReviewEvent[] {
  if (status === "all") return [...events];
  return events.filter((event) => event.status === status);
}

export type ReviewAction =
  | "approve"
  | "reject"
  | "timeline-yes"
  | "timeline-no"
  | "timeline-toggle"
  | "next"
  | "prev"
  | "list"
  | "help"
  | "quit"
  | { jump: number }
  | { unknown: string };

/** One command from the prompt. A bare number is an event id. Enter moves on without deciding. */
export function parseReviewAction(line: string): ReviewAction {
  const text = line.trim().toLowerCase();
  if (text === "" || text === "n" || text === "next" || text === "s" || text === "skip") return "next";
  if (text === "p" || text === "prev" || text === "previous" || text === "b" || text === "back") return "prev";
  if (text === "a" || text === "approve" || text === "y" || text === "yes") return "approve";
  if (text === "r" || text === "reject" || text === "x" || text === "no") return "reject";
  if (text === "t" || text === "timeline") return "timeline-toggle";
  if (text === "ty" || text === "t yes" || text === "timeline yes") return "timeline-yes";
  if (text === "tn" || text === "t no" || text === "timeline no") return "timeline-no";
  if (text === "l" || text === "list") return "list";
  if (text === "?" || text === "h" || text === "help") return "help";
  if (text === "q" || text === "quit" || text === "exit") return "quit";
  if (/^\d+$/.test(text)) return { jump: Number(text) };
  return { unknown: line.trim() };
}

export function renderReviewCard(
  event: ReviewEvent,
  labels: SpeakerLabels,
  place: { index: number; total: number },
): string {
  const lines = [
    `event ${event.id}    ${place.index + 1}/${place.total}    ${event.category}    sig ${event.significance}`,
    `status: ${event.status}    timeline: ${event.onTimeline ? "yes" : "no"}`,
    formatLocal(event.occurredAt),
  ];
  if (event.endedAt) lines.push(`ended ${formatLocal(event.endedAt)}`);
  if (event.isFirst || event.firstCheck) {
    lines.push(`first ${event.isFirst ? "yes" : "no"}${event.firstCheck ? ` (${event.firstCheck})` : ""}`);
  }
  lines.push("", wrap(event.title), wrap(event.summary));
  if (event.saying) {
    lines.push("", `speaker  ${labels[event.saying.personId]}`, wrap(event.saying.quote));
  }
  lines.push("", "evidence");
  for (const entry of event.evidence.slice(0, EVIDENCE_SHOWN)) {
    const text = collapseWhitespace(entry.text);
    const preview = text.length > EVIDENCE_CHARS ? `${text.slice(0, EVIDENCE_CHARS)}…` : text;
    lines.push(
      `  [${refOf(entry.messageId)}] ${formatLocal(entry.sentAt)} ${labels[entry.personId]} ${SOURCE_TAG[entry.source]} (${entry.role})`,
    );
    lines.push(indent(wrap(preview, LINE_WIDTH - 2)));
  }
  const rest = event.evidence.length - EVIDENCE_SHOWN;
  if (rest > 0) lines.push(`  + ${rest} more`);
  lines.push("", REVIEW_KEYS);
  return lines.join("\n");
}

/** Titles from the current event forward, so you can pick an id to jump to. */
export function renderReviewList(events: readonly ReviewEvent[], current: number): string {
  const slice = events.slice(current, current + LIST_COUNT);
  const lines = slice.map((event, offset) => {
    const at = current + offset;
    const title = event.title.length > 52 ? `${event.title.slice(0, 51)}…` : event.title;
    const timeline = event.onTimeline ? "yes" : "no";
    return `${at === current ? ">" : " "} ${String(event.id).padStart(6)}  ${event.status.padEnd(8)}  timeline ${timeline}  ${event.category.padEnd(14)}  ${title}`;
  });
  const more = events.length - (current + slice.length);
  if (more > 0) lines.push(`  ${more} more`);
  return lines.join("\n");
}

export const REVIEW_HELP = [
  "a, approve     chat can use it; timeline stays as it is",
  "r, reject      keep it out of chat and the timeline",
  "t              toggle timeline yes/no (timeline page needs status approved + timeline yes)",
  "ty / tn        set timeline to yes or no",
  "enter, n       leave it unchanged and move on",
  "p              previous event",
  "l              list ids and titles from here",
  "a number       jump to that event id",
  "q              quit (decisions already saved stay saved)",
].join("\n");

export type ReviewDecision = "approved" | "rejected";

/** What the terminal reviewer just chose. Status and timeline are independent. */
export type ReviewChange = {
  status?: ReviewDecision;
  onTimeline?: boolean;
};

export type ReviewLoopResult = { approved: number; rejected: number; timeline: number };

/**
 * Walks the queue one event at a time. Approve is for chat. Timeline yes/no is separate; the
 * timeline page only shows events that are approved (or edited) and timeline yes. Each save
 * happens before the next prompt, so closing the terminal keeps what was already decided.
 */
export async function runReviewLoop(options: {
  events: ReviewEvent[];
  labels: SpeakerLabels;
  read: () => Promise<string | null>;
  write: (text: string) => void;
  apply: (event: ReviewEvent, change: ReviewChange) => Promise<void>;
  /** Printed above every card. A terminal clears the screen between events, so this has to be redrawn. */
  banner?: string;
  clear?: boolean;
}): Promise<ReviewLoopResult> {
  const { events, labels } = options;
  const counts: ReviewLoopResult = { approved: 0, rejected: 0, timeline: 0 };
  let index = 0;
  let note = "";
  let showCard = true;
  let started = false;

  const say = (text: string) => options.write(text);

  const draw = () => {
    if (options.clear) say("\x1B[2J\x1B[H");
    else if (started) say("─".repeat(LINE_WIDTH));
    started = true;
    if (options.banner) say(options.banner);
    if (note) {
      say(note);
      note = "";
    }
    if (index >= events.length) {
      say("end of the queue. p goes back, q quits.");
      return;
    }
    const event = events[index] as ReviewEvent;
    say(renderReviewCard(event, labels, { index, total: events.length }));
  };

  while (true) {
    if (showCard) draw();
    showCard = true;
    const line = await options.read();
    if (line === null) break;
    const action = parseReviewAction(line);

    if (action === "quit") break;
    if (action === "help") {
      say(REVIEW_HELP);
      showCard = false;
      continue;
    }
    if (action === "list") {
      say(renderReviewList(events, Math.min(index, Math.max(events.length - 1, 0))));
      showCard = false;
      continue;
    }
    if (typeof action === "object" && "unknown" in action) {
      say(`unknown command. ${REVIEW_KEYS}`);
      showCard = false;
      continue;
    }
    if (typeof action === "object" && "jump" in action) {
      const at = events.findIndex((event) => event.id === action.jump);
      if (at === -1) {
        say(`event ${action.jump} is not in this list`);
        showCard = false;
      } else {
        index = at;
      }
      continue;
    }
    if (action === "next") {
      index = Math.min(index + 1, events.length);
      continue;
    }
    if (action === "prev") {
      index = Math.max(index - 1, 0);
      continue;
    }

    if (index >= events.length) {
      say("end of the queue. p goes back, q quits.");
      showCard = false;
      continue;
    }
    const event = events[index] as ReviewEvent;
    const change = changeFor(action, event);
    if (!change) {
      note = `event ${event.id} is already ${event.status}, timeline ${event.onTimeline ? "yes" : "no"}`;
      index = Math.min(index + 1, events.length);
      continue;
    }

    try {
      await options.apply(event, change);
    } catch (error) {
      say(error instanceof Error ? error.message : "could not save");
      showCard = false;
      continue;
    }

    if (change.status) {
      event.status = change.status;
      counts[change.status]++;
    }
    if (change.onTimeline !== undefined) {
      event.onTimeline = change.onTimeline;
      counts.timeline++;
    }
    // Rejected events never belong on the timeline page.
    if (change.status === "rejected" && event.onTimeline) {
      event.onTimeline = false;
    }
    note = describeChange(event.id, change);
    index = Math.min(index + 1, events.length);
  }

  say(
    `stopped. approved ${counts.approved}, rejected ${counts.rejected}, timeline ${counts.timeline} this session.`,
  );
  return counts;
}

function changeFor(action: ReviewAction, event: ReviewEvent): ReviewChange | null {
  if (action === "approve") {
    if (event.status === "approved") return null;
    return { status: "approved" };
  }
  if (action === "reject") {
    if (event.status === "rejected" && !event.onTimeline) return null;
    return event.onTimeline ? { status: "rejected", onTimeline: false } : { status: "rejected" };
  }
  if (action === "timeline-yes") {
    if (event.onTimeline) return null;
    // The timeline page needs an approved row; a draft with timeline yes would never show.
    return event.status === "draft" ? { status: "approved", onTimeline: true } : { onTimeline: true };
  }
  if (action === "timeline-no") {
    if (!event.onTimeline) return null;
    return { onTimeline: false };
  }
  if (action === "timeline-toggle") {
    const onTimeline = !event.onTimeline;
    if (onTimeline && event.status === "draft") return { status: "approved", onTimeline: true };
    return { onTimeline };
  }
  return null;
}

function describeChange(id: number, change: ReviewChange): string {
  const parts: string[] = [];
  if (change.status) parts.push(change.status);
  if (change.onTimeline !== undefined) parts.push(`timeline ${change.onTimeline ? "yes" : "no"}`);
  return `event ${id}: ${parts.join(", ")}`;
}

function wrap(text: string, width = LINE_WIDTH): string {
  const words = collapseWhitespace(text).split(" ").filter((word) => word !== "");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line === "") {
      line = word;
      continue;
    }
    if (line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = `${line} ${word}`;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
