import { describe, expect, test } from "bun:test";
import { dayKey, formatLocal, monthKey, parseLocal } from "./time";

describe("time", () => {
  test("formats an instant as India time", () => {
    // 2030-01-05 18:00 UTC is 23:30 IST.
    expect(formatLocal(new Date("2030-01-05T18:00:00Z"))).toBe("2030-01-05 23:30");
    // 20:00 UTC crosses midnight in IST.
    expect(dayKey(new Date("2030-01-05T20:00:00Z"))).toBe("2030-01-06");
    expect(monthKey(new Date("2030-01-31T20:00:00Z"))).toBe("2030-02");
  });

  test("reads wall time in the display timezone", () => {
    const parsed = parseLocal("2030-01-05 23:30");
    expect(parsed?.instant.toISOString()).toBe("2030-01-05T18:00:00.000Z");
    expect(parsed?.granularity).toBe("minute");
    expect(parseLocal("2030-01-05T23:30")?.instant.toISOString()).toBe("2030-01-05T18:00:00.000Z");
  });

  test("a bare day is noon and a bare month is noon on the 1st", () => {
    expect(formatLocal(parseLocal("2030-01-05")!.instant)).toBe("2030-01-05 12:00");
    expect(parseLocal("2030-01-05")?.granularity).toBe("day");
    expect(formatLocal(parseLocal("2030-03")!.instant)).toBe("2030-03-01 12:00");
    expect(parseLocal("2030-03")?.granularity).toBe("month");
  });

  test("rejects junk and impossible dates", () => {
    expect(parseLocal("yesterday")).toBeNull();
    expect(parseLocal("2030-02-30")).toBeNull();
    expect(parseLocal("2030-01-05 25:00")).toBeNull();
    expect(parseLocal("2030-13")).toBeNull();
  });
});
