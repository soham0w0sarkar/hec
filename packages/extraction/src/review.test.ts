import { describe, expect, test } from "bun:test";
import { parseReview, planReviewImport, renderReview, setReviewStatus, setReviewTimeline, type ReviewEvent } from "./review";
import { LABELS, msg } from "./test-helpers";
import { parseLocal } from "./time";

const at = (value: string) => parseLocal(value)!.instant;
const header = { runId: 7, model: "m", promptVersion: "extract.v1", exportedAt: new Date("2030-02-01T00:00:00Z") };

function evidence(id: number, when: string, who: "person_1" | "person_2", text: string, role: "primary" | "supporting" = "primary") {
  const m = msg(id, when, who, text);
  return { messageId: id, role, personId: m.personId, sentAt: m.sentAt, source: m.source, text: m.text };
}

function event(overrides: Partial<ReviewEvent> = {}): ReviewEvent {
  return {
    id: 101,
    category: "Meetup",
    title: "Coffee together",
    summary: "They met for coffee.",
    occurredAt: at("2030-01-05 18:00"),
    datePrecision: "exact_day",
    endedAt: null,
    significance: 2,
    isFirst: false,
    firstCheck: null,
    status: "draft",
    onTimeline: false,
    saying: null,
    evidence: [evidence(1, "2030-01-05 18:00", "person_1", "see you at the cafe\nbring umbrella")],
    ...overrides,
  };
}

const saying = event({
  id: 102,
  category: "Saying",
  title: "A line",
  evidence: [evidence(2, "2030-01-05 18:30", "person_2", "Tum mere liye sab kuch ho")],
  saying: { personId: "person_2", quote: "mere liye sab kuch" },
  occurredAt: at("2030-01-05 18:30"),
});

function plan(events: ReviewEvent[], edit: (text: string) => string) {
  const parsed = parseReview(edit(renderReview(header, events, LABELS)));
  expect(parsed.errors).toEqual([]);
  return planReviewImport(events, parsed.events, LABELS);
}

describe("renderReview", () => {
  const text = renderReview(header, [saying, event()], LABELS);

  test("has date, category, title, summary, evidence quotes, status for each event, oldest first", () => {
    expect(text).toContain("## event 101");
    expect(text).toContain("status: draft");
    expect(text).toContain("category: Meetup");
    expect(text).toContain("date: 2030-01-05 18:00");
    expect(text).toContain("title: Coffee together");
    expect(text).toContain("summary: They met for coffee.");
    expect(text).toContain("[m1] 2030-01-05 18:00 Ravi ig (primary): see you at the cafe bring umbrella");
    expect(text.indexOf("## event 101")).toBeLessThan(text.indexOf("## event 102"));
  });

  test("a Saying shows speaker and quote; others do not", () => {
    expect(text).toContain("speaker: Anita");
    expect(text).toContain("quote: mere liye sab kuch");
    expect(renderReview(header, [event()], LABELS)).not.toContain("quote:");
  });

  test("shows the first check", () => {
    expect(renderReview(header, [event({ isFirst: false, firstCheck: "refuted" })], LABELS)).toContain("first: no (refuted)");
  });

  test("cuts long evidence for reading", () => {
    const long = event({ evidence: [evidence(1, "2030-01-05 18:00", "person_1", "x".repeat(500))] });
    expect(renderReview(header, [long], LABELS)).toContain(`${"x".repeat(240)}…`);
  });
});

describe("parseReview", () => {
  test("reads the editable lines and ignores evidence", () => {
    const parsed = parseReview(renderReview(header, [event()], LABELS));
    expect(parsed.errors).toEqual([]);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]?.id).toBe(101);
    expect(parsed.events[0]?.fields.title).toBe("Coffee together");
    expect(parsed.events[0]?.fields).not.toHaveProperty("evidence");
  });

  test("reports a block with no id and a repeated id", () => {
    const parsed = parseReview("## event abc\nstatus: approved\n\n## event 5\nstatus: approved\n\n## event 5\nstatus: rejected\n");
    expect(parsed.events).toHaveLength(1);
    expect(parsed.errors).toHaveLength(2);
  });
});

describe("setReviewStatus", () => {
  test("changes one event's status line and leaves the rest of the file", () => {
    const text = renderReview(header, [event(), saying], LABELS);
    const next = setReviewStatus(text, 101, "approved");
    expect(next.found).toBe(true);
    expect(next.text).toContain("## event 101\nstatus: approved\n");
    expect(next.text).toContain("## event 102\nstatus: draft\n");
    expect(next.text).toContain("quote: mere liye sab kuch");
    expect(setReviewStatus(text, 999, "rejected")).toEqual({ text, found: false });
  });
});

describe("setReviewTimeline", () => {
  test("updates an existing timeline line and adds one under status when the export has none", () => {
    const text = renderReview(header, [event()], LABELS);
    const updated = setReviewTimeline(text, 101, true);
    expect(updated.found).toBe(true);
    expect(updated.text).toContain("timeline: yes");

    const older = text.replace("timeline: no\n", "");
    const inserted = setReviewTimeline(older, 101, true);
    expect(inserted.text).toContain("status: draft\ntimeline: yes\n");
    expect(setReviewTimeline(text, 999, false)).toEqual({ text, found: false });
  });
});

describe("planReviewImport", () => {
  test("an untouched file changes nothing", () => {
    const result = plan([event(), saying], (t) => t);
    expect(result.updates).toEqual([]);
    expect(result.unchanged).toBe(2);
  });

  test("approved with no edits stays approved", () => {
    const result = plan([event()], (t) => t.replace("status: draft", "status: approved"));
    expect(result.updates).toEqual([{ id: 101, status: "approved", changes: {} }]);
  });

  test("editing a field on an approved event makes it edited", () => {
    const result = plan([event()], (t) => t.replace("status: draft", "status: approved").replace("title: Coffee together", "title: Chai together"));
    expect(result.updates).toEqual([{ id: 101, status: "edited", changes: { title: "Chai together" } }]);
  });

  test("rejected ignores edits", () => {
    const result = plan([event()], (t) => t.replace("status: draft", "status: rejected").replace("significance: 2", "significance: 9"));
    expect(result.updates).toEqual([{ id: 101, status: "rejected", changes: {} }]);
    expect(result.problems).toEqual([]);
  });

  test("edited with no change is still edited", () => {
    const result = plan([event()], (t) => t.replace("status: draft", "status: edited"));
    expect(result.updates[0]?.status).toBe("edited");
  });

  test("edits dates, precision, end, significance, first and category", () => {
    const result = plan([event()], (t) =>
      t
        .replace("status: draft", "status: edited")
        .replace("date: 2030-01-05 18:00", "date: 2030-01-04")
        .replace("precision: exact_day", "precision: approximate")
        .replace("ended: -", "ended: 2030-01-06 10:00")
        .replace("significance: 2", "significance: 3")
        .replace("first: no", "first: yes")
        .replace("category: Meetup", "category: Trip"),
    );
    expect(result.problems).toEqual([]);
    expect(result.updates[0]?.changes).toEqual({
      category: "Trip",
      occurredAt: at("2030-01-04"),
      datePrecision: "approximate",
      endedAt: at("2030-01-06 10:00"),
      significance: 3,
      isFirst: true,
    });
  });

  test("a reviewer may move a date outside the evidence range", () => {
    const result = plan([event()], (t) => t.replace("status: draft", "status: edited").replace("date: 2030-01-05 18:00", "date: 2029-12-25"));
    expect(result.problems).toEqual([]);
  });

  test("bad values are problems for that event only", () => {
    const events = [event(), event({ id: 103 })];
    const parsed = parseReview(
      renderReview(header, events, LABELS)
        .replace("status: draft", "status: edited")
        .replace("category: Meetup", "category: Hangout"),
    );
    const result = planReviewImport(events, parsed.events, LABELS);
    expect(result.problems).toEqual([{ id: 101, problem: "category is not one of the nine" }]);
    expect(result.updates).toEqual([]);
    expect(result.unchanged).toBe(1);

    for (const [from, to, problem] of [
      ["significance: 2", "significance: 4", "significance must be 1, 2 or 3"],
      ["date: 2030-01-05 18:00", "date: someday", "date is not YYYY-MM-DD HH:mm, YYYY-MM-DD or YYYY-MM"],
      ["precision: exact_day", "precision: day", "precision must be exact_day, month, approximate"],
      ["first: no", "first: maybe", "first must be yes or no"],
      ["title: Coffee together", "title: ", "title is empty"],
      ["ended: -", "ended: 2030-01-05 10:00", "ended must be after date"],
    ] as const) {
      const r = plan([event()], (t) => t.replace("status: draft", "status: edited").replace(from, to));
      expect(r.problems[0]?.problem).toBe(problem);
    }
  });

  test("an unknown id and an unknown status are reported", () => {
    const parsed = parseReview("## event 999\nstatus: approved\n\n## event 101\nstatus: maybe\n");
    const result = planReviewImport([event()], parsed.events, LABELS);
    expect(result.problems.map((p) => p.id)).toEqual([999, 101]);
  });

  test("a Saying edit still has to be a verbatim quote from the right speaker", () => {
    const ok = plan([saying], (t) => t.replace("status: draft", "status: edited").replace("quote: mere liye sab kuch", "quote: sab kuch ho"));
    expect(ok.updates[0]?.changes.saying).toEqual({ personId: "person_2", quote: "sab kuch ho" });

    const invented = plan([saying], (t) => t.replace("status: draft", "status: edited").replace("quote: mere liye sab kuch", "quote: made up"));
    expect(invented.problems[0]?.problem).toBe("quote is not word for word in an evidence message");

    const wrong = plan([saying], (t) => t.replace("status: draft", "status: edited").replace("speaker: Anita", "speaker: Ravi"));
    expect(wrong.problems[0]?.problem).toBe("speaker did not send the quoted message");
  });

  test("turning a Saying into another category clears the quote; turning an event into a Saying needs one", () => {
    const away = plan([saying], (t) => t.replace("status: draft", "status: edited").replace("category: Saying", "category: Milestone"));
    expect(away.updates[0]?.changes.saying).toBeNull();

    const toSaying = plan([event()], (t) => t.replace("status: draft", "status: edited").replace("category: Meetup", "category: Saying"));
    expect(toSaying.problems[0]?.problem).toBe("a Saying needs a quote");
  });
});
