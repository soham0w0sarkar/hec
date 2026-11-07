import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { EVENT_STATUSES, type EventStatus } from "@hec/core";
import { createDb } from "@hec/db";
import { createExtractionQueue } from "@hec/queue";
import { createSqlStore } from "./store";
import { startRun, resumeRun } from "./run";
import { exportReview, importReview, resolveReviewPath, reviewFileName, syncReviewDecision } from "./review-files";
import { runReviewLoop, selectReviewEvents } from "./review-cli";
import { CURRENT_PROMPT } from "./prompt";
import { extractionModelName } from "./model";

const USAGE = `usage:
  bun run extract                              start a run over every session (needs the worker running)
  bun run extract -- --resume <run>            queue the unfinished sessions of an open run
  bun run extract -- --resume <run> --session <id>   re-run one session inside an open run
  bun run review [-- --run <run>] [--status draft|approved|edited|rejected|all]
                                             approve or reject one event at a time
  bun run review:export [-- --run <run>] [--force]   write data/review/run-<id>.md
  bun run review:import -- <file> [--dry-run]        apply an edited review file`;

type Parsed = { command: string; flags: Map<string, string | true>; positional: string[] };

/** Parses `--name value`, `--name=value` and bare `--flag`. Unknown flags are kept and checked by callers. */
export function parseArgs(argv: string[]): Parsed {
  const [command = "", ...rest] = argv.filter((arg) => arg !== "--");
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--") && !["force", "dry-run"].includes(arg.slice(2))) {
      flags.set(arg.slice(2), next);
      i++;
    } else {
      flags.set(arg.slice(2), true);
    }
  }
  return { command, flags, positional };
}

function intFlag(flags: Map<string, string | true>, name: string): number | undefined {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  if (value === true || !/^\d+$/.test(value)) throw new Error(`--${name} needs a whole number`);
  return Number(value);
}

async function main(argv: string[]): Promise<number> {
  const { command, flags, positional } = parseArgs(argv);
  if (command === "") {
    console.error(USAGE);
    return 1;
  }

  const sql = createDb(process.env.DATABASE_URL, { max: 2 });
  const store = createSqlStore(sql);
  try {
    if (command === "extract") {
      const queue = createExtractionQueue(process.env.REDIS_URL);
      try {
        const resume = intFlag(flags, "resume");
        const session = intFlag(flags, "session");
        if (resume === undefined) {
          if (session !== undefined) throw new Error("--session needs --resume <run>");
          const model = extractionModelName(process.env);
          const started = await startRun(store, queue, { model, promptVersion: CURRENT_PROMPT });
          console.log(`run ${started.runId} started: ${started.sessions} sessions queued.`);
          console.log("the worker does the work; watch its output. When every session is done the run is finalized.");
        } else {
          const resumed = await resumeRun(store, queue, resume, { sessionId: session });
          console.log(`run ${resume}: queued ${resumed.queued.length} session job(s)${resumed.finalizeQueued ? ", finalize queued" : ""}.`);
        }
      } finally {
        await queue.close();
      }
      return 0;
    }

    if (command === "review") {
      const runId = intFlag(flags, "run") ?? (await store.latestFinalizedRunId());
      if (runId === null) throw new Error("no finished run yet. Start one with `bun run extract`.");
      const run = await store.getRun(runId);
      if (!run) throw new Error(`run ${runId} does not exist`);
      if (run.status !== "succeeded") throw new Error(`run ${runId} is ${run.status}; only finished runs can be reviewed`);

      const status = statusFlag(flags.get("status"));
      const labels = await store.speakerLabels();
      const events = selectReviewEvents(await store.runEvents(runId), status);
      const which = status === "all" ? "event(s)" : `${status} event(s)`;
      if (events.length === 0) {
        console.log(`run ${runId}: no ${which}.`);
        return 0;
      }

      if (input.isTTY !== true) {
        throw new Error("review needs a real terminal (stdin is not a TTY). Run `bun run review` from the repo root, not through a pipe or bun --filter.");
      }

      const file = reviewFileName(runId);
      const prompt = createInterface({ input, output });
      try {
        await runReviewLoop({
          events,
          labels,
          banner: `run ${runId}: ${events.length} ${which}. a = chat, t = timeline yes/no, r = reject, q quits.`,
          clear: output.isTTY === true,
          read: () => prompt.question("> "),
          write: (text) => output.write(`${text}\n`),
          apply: async (event, change) => {
            const status =
              change.status ??
              (event.status === "draft" ? "approved" : (event.status as "approved" | "edited" | "rejected"));
            const onTimeline = change.onTimeline ?? event.onTimeline;
            const changes = change.onTimeline === undefined ? {} : { onTimeline: change.onTimeline };
            await store.applyReview(runId, [{ id: event.id, status, changes }], events);
            const synced = await syncReviewDecision(runId, event.id, status, onTimeline);
            if (synced === "not-in-file") {
              console.error(`event ${event.id} is not in data/review/${file}; the database was updated`);
            }
          },
        });
      } finally {
        prompt.close();
      }
      return 0;
    }

    if (command === "review:export") {
      const labels = await store.speakerLabels();
      const result = await exportReview(store, {
        runId: intFlag(flags, "run"),
        labels,
        force: flags.has("force"),
      });
      console.log(`wrote ${result.path} (${result.events} events from run ${result.runId})`);
      return 0;
    }

    if (command === "review:import") {
      const file = positional[0];
      if (!file) throw new Error("review:import needs the path of the review file");
      const labels = await store.speakerLabels();
      const outcome = await importReview(store, resolveReviewPath(file), { labels, apply: !flags.has("dry-run") });
      if (outcome.errors.length > 0) {
        console.error("the file is not valid, nothing was applied:");
        for (const error of outcome.errors) console.error(`  - ${error}`);
        return 1;
      }
      const { plan } = outcome;
      const verb = flags.has("dry-run") ? "would change" : "changed";
      console.log(`run ${outcome.runId}: ${verb} ${plan.updates.length} event(s), ${plan.unchanged} unchanged`);
      for (const problem of plan.problems) console.log(`  skipped event ${problem.id}: ${problem.problem}`);
      if (!flags.has("dry-run")) console.log(`applied ${outcome.applied}`);
      return plan.problems.length > 0 ? 2 : 0;
    }

    console.error(USAGE);
    return 1;
  } finally {
    await sql.close();
  }
}

function statusFlag(value: string | true | undefined): EventStatus | "all" {
  if (value === undefined) return "draft";
  if (value === true) throw new Error("--status needs draft, approved, edited, rejected, or all");
  if (value === "all" || (EVENT_STATUSES as readonly string[]).includes(value)) return value as EventStatus | "all";
  throw new Error(`--status must be draft, approved, edited, rejected, or all`);
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "unexpected error");
    process.exitCode = 1;
  }
}

