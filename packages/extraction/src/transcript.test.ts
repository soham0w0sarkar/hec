import { describe, expect, test } from "bun:test";
import { buildWindows, collapseWhitespace, formatLine, parseRef, refOf, usableMessages, type WindowOptions } from "./transcript";
import { LABELS, msg } from "./test-helpers";

const opts: WindowOptions = { labels: LABELS };

describe("refs", () => {
  test("round trip, and tolerate brackets", () => {
    expect(refOf(123)).toBe("m123");
    expect(parseRef("m123")).toBe(123);
    expect(parseRef("[m123]")).toBe(123);
    expect(parseRef(" m7 ")).toBe(7);
  });

  test("anything else is not a ref", () => {
    expect(parseRef("123")).toBeNull();
    expect(parseRef("m")).toBeNull();
    expect(parseRef("m1x")).toBeNull();
    expect(parseRef(5)).toBeNull();
    expect(parseRef("m99999999999999999999")).toBeNull();
  });
});

describe("formatLine", () => {
  test("ref, IST time, the speaker's name and source", () => {
    const line = formatLine(msg(5, "2030-01-05 21:07", "person_2", "hello  there\nfriend", { source: "whatsapp" }), opts);
    expect(line).toBe("[m5] 2030-01-05 21:07 Anita wa: hello there friend");
  });

  test("uses whatever names the labels hold, not me or her", () => {
    const line = formatLine(msg(5, "2030-01-05 21:07", "person_1", "hi"), { labels: { person_1: "Dev", person_2: "Maya" } });
    expect(line).toContain(" Dev ig: hi");
    expect(line).not.toMatch(/\bme\b/);
  });

  test("marks non-text messages", () => {
    expect(formatLine(msg(6, "2030-01-05 21:07", "person_1", "", { kind: "media" }), opts)).toContain("Ravi ig: <media>");
    expect(formatLine(msg(7, "2030-01-05 21:07", "person_1", "12 min", { kind: "call" }), opts)).toContain("<call> 12 min");
  });

  test("cuts very long lines", () => {
    const line = formatLine(msg(8, "2030-01-05 21:07", "person_1", "x".repeat(50)), { ...opts, maxLineChars: 10 });
    expect(line.endsWith("xxxxxxxxxx…")).toBe(true);
  });
});

describe("usableMessages", () => {
  test("drops system and unsent lines and sorts by time then id", () => {
    const messages = [
      msg(3, "2030-01-05 10:02", "person_1", "c"),
      msg(2, "2030-01-05 10:00", "person_1", "a"),
      msg(1, "2030-01-05 10:00", "person_2", "b", { kind: "system" }),
      msg(4, "2030-01-05 10:03", "person_2", "d", { kind: "unsent" }),
    ];
    expect(usableMessages(messages).map((m) => m.id)).toEqual([2, 3]);
  });
});

describe("buildWindows", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      msg(
        i + 1,
        `2030-01-05 ${String(10 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`,
        i % 2 ? "person_1" : "person_2",
        `message number ${i}`,
      ),
    );

  test("a short session is one window", () => {
    const windows = buildWindows(many(5), opts);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.total).toBe(1);
    expect(windows[0]?.transcript.split("\n")).toHaveLength(5);
  });

  test("an empty session has no windows", () => {
    expect(buildWindows([], opts)).toEqual([]);
    expect(buildWindows([msg(1, "2030-01-05 10:00", "person_1", "x", { kind: "system" })], opts)).toEqual([]);
  });

  test("a long session splits with overlap and covers every message", () => {
    const messages = many(50);
    const windows = buildWindows(messages, { ...opts, maxMessages: 20, overlap: 5 });
    expect(windows.length).toBeGreaterThan(2);
    expect(windows.every((w) => w.total === windows.length)).toBe(true);

    const seen = new Set(windows.flatMap((w) => w.messages.map((m) => m.id)));
    expect(seen.size).toBe(50);

    for (let i = 1; i < windows.length; i++) {
      const prev = new Set((windows[i - 1] as (typeof windows)[number]).messages.map((m) => m.id));
      const shared = (windows[i] as (typeof windows)[number]).messages.filter((m) => prev.has(m.id));
      expect(shared.length).toBe(5);
    }
  });

  test("the character budget splits too, and an oversized message still makes progress", () => {
    const messages = [
      msg(1, "2030-01-05 10:00", "person_1", "a".repeat(200)),
      msg(2, "2030-01-05 10:01", "person_2", "b".repeat(200)),
      msg(3, "2030-01-05 10:02", "person_1", "c".repeat(200)),
    ];
    const windows = buildWindows(messages, { ...opts, maxChars: 100, overlap: 0 });
    expect(windows.map((w) => w.messages.map((m) => m.id))).toEqual([[1], [2], [3]]);
  });

  test("collapseWhitespace flattens newlines", () => {
    expect(collapseWhitespace("  a\n\n b\t c ")).toBe("a b c");
  });
});
