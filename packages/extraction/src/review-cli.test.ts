import { describe, expect, test } from "bun:test";
import { parseReviewAction, renderReviewCard, renderReviewList, runReviewLoop, selectReviewEvents } from "./review-cli";
import type { ReviewEvent } from "./review";
import { LABELS, msg } from "./test-helpers";
import { parseLocal } from "./time";

const at = (value: string) => parseLocal(value)!.instant;

function evidence(id: number, when: string, who: "person_1" | "person_2", text: string) {
  const message = msg(id, when, who, text);
  return {
    messageId: id,
    role: "primary" as const,
    personId: message.personId,
    sentAt: message.sentAt,
    source: message.source,
    text: message.text,
  };
}

function event(id: number, title: string, status: ReviewEvent["status"] = "draft"): ReviewEvent {
  return {
    id,
    category: "Saying",
    title,
    summary: `About ${title}.`,
    occurredAt: at("2030-01-05 18:00"),
    datePrecision: "exact_day",
    endedAt: null,
    significance: 2,
    isFirst: false,
    firstCheck: null,
    status,
    onTimeline: false,
    saying: { personId: "person_2", quote: "mere liye sab kuch" },
    evidence: [evidence(id, "2030-01-05 18:00", "person_2", "Tum mere liye sab kuch ho")],
  };
}

describe("parseReviewAction", () => {
  test("letters, words, enter, timeline, and an event id", () => {
    expect(parseReviewAction("")).toBe("next");
    expect(parseReviewAction("n")).toBe("next");
    expect(parseReviewAction("A")).toBe("approve");
    expect(parseReviewAction("reject")).toBe("reject");
    expect(parseReviewAction("t")).toBe("timeline-toggle");
    expect(parseReviewAction("ty")).toBe("timeline-yes");
    expect(parseReviewAction("tn")).toBe("timeline-no");
    expect(parseReviewAction("p")).toBe("prev");
    expect(parseReviewAction("l")).toBe("list");
    expect(parseReviewAction("?")).toBe("help");
    expect(parseReviewAction("q")).toBe("quit");
    expect(parseReviewAction("80")).toEqual({ jump: 80 });
    expect(parseReviewAction("nope")).toEqual({ unknown: "nope" });
  });
});

describe("selectReviewEvents", () => {
  test("drafts only, unless every status is asked for", () => {
    const events = [event(1, "One"), event(2, "Two", "approved"), event(3, "Three", "rejected")];
    expect(selectReviewEvents(events, "draft").map((item) => item.id)).toEqual([1]);
    expect(selectReviewEvents(events, "all")).toHaveLength(3);
  });
});

describe("renderReviewCard", () => {
  test("shows status and timeline as separate fields", () => {
    const card = renderReviewCard(event(7, "A sweet line"), LABELS, { index: 2, total: 10 });
    expect(card).toContain("event 7    3/10    Saying    sig 2");
    expect(card).toContain("status: draft    timeline: no");
    expect(card).toContain("A sweet line");
    expect(card).toContain("speaker  Anita");
    expect(card).toContain("mere liye sab kuch");
    expect(card).toContain("[m7] 2030-01-05 18:00 Anita ig (primary)");
    expect(card).toContain("a approve");
    expect(card).toContain("t timeline");
  });
});

describe("renderReviewList", () => {
  test("marks the current event and keeps the id", () => {
    const list = renderReviewList([event(4, "First"), event(9, "Second")], 1);
    expect(list.startsWith(">      9")).toBe(true);
    expect(list).toContain("Second");
    expect(list).toContain("timeline no");
    expect(list).not.toContain("First");
  });
});

describe("runReviewLoop", () => {
  test("approve leaves timeline alone; t sets timeline; reject clears it", async () => {
    const events = [event(1, "First"), event(2, "Second"), event(3, "Third")];
    const saved: { id: number; change: { status?: string; onTimeline?: boolean } }[] = [];
    const out: string[] = [];
    const lines = ["a", "t", "r", "q"];
    let cursor = 0;
    const result = await runReviewLoop({
      events,
      labels: LABELS,
      read: async () => (cursor < lines.length ? (lines[cursor++] as string) : null),
      write: (text) => out.push(text),
      apply: async (item, change) => {
        saved.push({ id: item.id, change });
      },
    });

    expect(saved).toEqual([
      { id: 1, change: { status: "approved" } },
      { id: 2, change: { status: "approved", onTimeline: true } },
      { id: 3, change: { status: "rejected" } },
    ]);
    expect(result).toEqual({ approved: 2, rejected: 1, timeline: 1 });
    expect(events.map((item) => item.status)).toEqual(["approved", "approved", "rejected"]);
    expect(events.map((item) => item.onTimeline)).toEqual([false, true, false]);
    const text = out.join("\n");
    expect(text).toContain("event 1: approved");
    expect(text).toContain("event 2: approved, timeline yes");
    expect(text).toContain("event 3: rejected");
    expect(text).toContain("stopped. approved 2, rejected 1, timeline 1 this session.");
  });

  test("timeline yes on an already approved event does not change status", async () => {
    const events = [event(1, "First", "approved")];
    const saved: { status?: string; onTimeline?: boolean }[] = [];
    const lines = ["ty", "q"];
    let cursor = 0;
    await runReviewLoop({
      events,
      labels: LABELS,
      read: async () => (cursor < lines.length ? (lines[cursor++] as string) : null),
      write: () => {},
      apply: async (_item, change) => {
        saved.push(change);
      },
    });
    expect(saved).toEqual([{ onTimeline: true }]);
    expect(events[0]?.status).toBe("approved");
    expect(events[0]?.onTimeline).toBe(true);
  });

  test("a failed save stays on that event", async () => {
    const events = [event(1, "First"), event(2, "Second")];
    const lines = ["a", "q"];
    let cursor = 0;
    const out: string[] = [];
    const result = await runReviewLoop({
      events,
      labels: LABELS,
      read: async () => (cursor < lines.length ? (lines[cursor++] as string) : null),
      write: (text) => out.push(text),
      apply: async () => {
        throw new Error("database refused");
      },
    });
    expect(result).toEqual({ approved: 0, rejected: 0, timeline: 0 });
    expect(events[0]?.status).toBe("draft");
    expect(out.join("\n")).toContain("database refused");
  });

  test("an unknown command and a missing id do not move", async () => {
    const events = [event(1, "First")];
    const lines = ["nope", "99", "q"];
    let cursor = 0;
    const out: string[] = [];
    await runReviewLoop({
      events,
      labels: LABELS,
      read: async () => (cursor < lines.length ? (lines[cursor++] as string) : null),
      write: (text) => out.push(text),
      apply: async () => {
        throw new Error("should not save");
      },
    });
    const text = out.join("\n");
    expect(text).toContain("unknown command");
    expect(text).toContain("event 99 is not in this list");
    expect(events[0]?.status).toBe("draft");
  });
});
