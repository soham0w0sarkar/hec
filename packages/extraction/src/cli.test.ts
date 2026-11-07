import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseArgs } from "./cli";
import { DEFAULT_REVIEW_DIR, resolveReviewPath } from "./review-files";

describe("parseArgs", () => {
  test("command, value flags and bare flags", () => {
    const parsed = parseArgs(["extract", "--resume", "7", "--session", "3"]);
    expect(parsed.command).toBe("extract");
    expect(parsed.flags.get("resume")).toBe("7");
    expect(parsed.flags.get("session")).toBe("3");
  });

  test("--force and --dry-run do not swallow the next argument", () => {
    const parsed = parseArgs(["review:import", "data/review/run-2.md", "--dry-run"]);
    expect(parsed.positional).toEqual(["data/review/run-2.md"]);
    expect(parsed.flags.get("dry-run")).toBe(true);
    const exported = parseArgs(["review:export", "--force", "--run", "2"]);
    expect(exported.flags.get("force")).toBe(true);
    expect(exported.flags.get("run")).toBe("2");
  });

  test("a relative review path is read from the repo root", () => {
    expect(resolveReviewPath("data/review/run-3.md")).toBe(join(DEFAULT_REVIEW_DIR, "run-3.md"));
    expect(resolveReviewPath("/tmp/run-3.md")).toBe("/tmp/run-3.md");
  });

  test("review status and run are flags", () => {
    const parsed = parseArgs(["review", "--run", "3", "--status", "approved"]);
    expect(parsed.command).toBe("review");
    expect(parsed.flags.get("run")).toBe("3");
    expect(parsed.flags.get("status")).toBe("approved");
  });

  test("the bare separator from bun run is ignored, and --name=value works", () => {
    const parsed = parseArgs(["review:export", "--", "--run=4"]);
    expect(parsed.command).toBe("review:export");
    expect(parsed.flags.get("run")).toBe("4");
  });
});
