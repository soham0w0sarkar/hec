import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventStatus } from "@hec/core";
import type { ExtractionStore } from "./store";
import { parseReview, planReviewImport, renderReview, setReviewStatus, setReviewTimeline, type ReviewPlan } from "./review";
import type { SpeakerLabels } from "./types";

/** Repo root. `bun --filter` runs this package from its own folder, so relative paths are not the caller's cwd. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** data/review at the repo root. Git ignores everything under data/, and review files hold real text. */
export const DEFAULT_REVIEW_DIR = join(REPO_ROOT, "data/review");

/** A relative path is from the repo root. An absolute path is left as given. */
export function resolveReviewPath(file: string): string {
  return isAbsolute(file) ? file : resolve(REPO_ROOT, file);
}

export function reviewFileName(runId: number): string {
  return `run-${runId}.md`;
}

export async function exportReview(
  store: ExtractionStore,
  options: { runId?: number; labels: SpeakerLabels; dir?: string; force?: boolean; now?: Date },
): Promise<{ path: string; runId: number; events: number }> {
  const runId = options.runId ?? (await store.latestFinalizedRunId());
  if (runId === null) throw new Error("no finished run yet. Start one with `bun run extract`.");
  const run = await store.getRun(runId);
  if (!run) throw new Error(`run ${runId} does not exist`);
  if (run.status !== "succeeded") throw new Error(`run ${runId} is ${run.status}; only finished runs can be reviewed`);

  const dir = options.dir ?? DEFAULT_REVIEW_DIR;
  const path = join(dir, reviewFileName(runId));
  if (existsSync(path) && !options.force) {
    // A review file may hold decisions that are not imported yet. Do not overwrite it silently.
    throw new Error(`${path} already exists. Import it, or pass --force to replace it.`);
  }

  const events = await store.runEvents(runId);
  const text = renderReview(
    { runId, model: run.model, promptVersion: run.promptVersion, exportedAt: options.now ?? new Date() },
    events,
    options.labels,
  );
  await mkdir(dir, { recursive: true });
  await writeFile(path, text, "utf8");
  return { path, runId, events: events.length };
}

export type ImportOutcome = {
  runId: number;
  plan: ReviewPlan;
  applied: number;
  errors: string[];
};

/**
 * Reads an edited review file and applies it to the run it came from. A file with malformed
 * blocks is refused entirely. An event with a bad value is skipped and reported, and the rest
 * still apply. With `apply: false` it only plans.
 */
export async function importReview(
  store: ExtractionStore,
  path: string,
  options: { labels: SpeakerLabels; apply: boolean },
): Promise<ImportOutcome> {
  const text = await readFile(path, "utf8");
  const header = /^run:\s*(\d+)/m.exec(text);
  if (!header) throw new Error("the file has no `run:` header line. Use an unedited export.");
  const runId = Number(header[1]);

  const parsed = parseReview(text);
  if (parsed.errors.length > 0) {
    return { runId, plan: { updates: [], unchanged: 0, problems: [] }, applied: 0, errors: parsed.errors };
  }

  const current = await store.runEvents(runId);
  const plan = planReviewImport(current, parsed.events, options.labels);
  let applied = 0;
  if (options.apply && plan.updates.length > 0) {
    applied = await store.applyReview(runId, plan.updates, current);
  }
  return { runId, plan, applied, errors: [] };
}

/**
 * Keeps an existing review file in step with a decision made in the terminal.
 * A missing file is left alone. A file that has no block for this event is reported, not rewritten.
 */
export async function syncReviewDecision(
  runId: number,
  id: number,
  status: EventStatus,
  onTimeline: boolean,
  dir = DEFAULT_REVIEW_DIR,
): Promise<"updated" | "missing" | "not-in-file"> {
  const path = join(dir, reviewFileName(runId));
  if (!existsSync(path)) return "missing";
  const original = await readFile(path, "utf8");
  const statusLine = setReviewStatus(original, id, status);
  if (!statusLine.found) return "not-in-file";
  const timeline = setReviewTimeline(statusLine.text, id, onTimeline);
  await writeFile(path, timeline.found ? timeline.text : statusLine.text, "utf8");
  return "updated";
}
