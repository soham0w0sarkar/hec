import { describe, expect, test } from "bun:test";
import { DEFAULT_INGEST_WORKERS } from "./run";
import { parseWorkerCount } from "./workers";

describe("parseWorkerCount", () => {
  test("reads the flag in both forms, then the env, then the default", () => {
    expect(parseWorkerCount(["--workers", "6"], "2")).toBe(6);
    expect(parseWorkerCount(["--workers=3"], undefined)).toBe(3);
    expect(parseWorkerCount([], "5")).toBe(5);
    expect(parseWorkerCount([], undefined)).toBe(DEFAULT_INGEST_WORKERS);
  });

  test("rejects zero, fractions, and values above the cap", () => {
    expect(() => parseWorkerCount(["--workers", "0"], undefined)).toThrow();
    expect(() => parseWorkerCount(["--workers=1.5"], undefined)).toThrow();
    expect(() => parseWorkerCount([], "99")).toThrow();
  });
});
