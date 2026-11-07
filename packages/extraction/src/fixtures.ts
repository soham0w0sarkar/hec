import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { MessageSource } from "@hec/core";
import { RawEventSchema } from "./schema";
import { dayKey, parseLocal } from "./time";
import type { Candidate, ExtractionMessage, SpeakerLabels } from "./types";

/** Invented chats only. Fixture message ids start here, far above any real id. */
export const FIXTURE_ID_FLOOR = 9_000_000;

export const FixtureSchema = z.object({
  /** Must be literally true. A reminder, and a check that nobody pasted a real export. */
  synthetic: z.literal(true),
  name: z.string().min(1),
  description: z.string(),
  /** Invented display names, used exactly as the real speaker labels are used. */
  labels: z.object({ person_1: z.string().min(1), person_2: z.string().min(1) }),
  messages: z
    .array(
      z.object({
        id: z.number().int().min(FIXTURE_ID_FLOOR),
        /** IST wall time, `YYYY-MM-DD HH:mm`. Fixtures use years in the 2030s so they cannot be real. */
        at: z.string(),
        who: z.enum(["person_1", "person_2"]),
        source: z.enum(["ig", "wa"]).default("ig"),
        text: z.string(),
        kind: z.enum(["text", "media", "call", "share"]).default("text"),
      }),
    )
    .min(1),
  /** What a perfect model would return, in the model's own output shape. */
  expected: z.array(RawEventSchema),
  /** Categories that must not show up for this session (for example Trip on a plan-only chat). */
  forbiddenCategories: z.array(z.string()).default([]),
});
export type Fixture = z.infer<typeof FixtureSchema>;

const SOURCES: Record<"ig" | "wa", MessageSource> = { ig: "instagram", wa: "whatsapp" };

export function defaultFixturesDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../../evals/extraction/fixtures");
}

/** Reads every *.json in `dir`. Refuses a directory under data/, where real chats live. */
export function loadFixtures(dir = defaultFixturesDir()): Fixture[] {
  const resolved = resolve(dir);
  if (resolved.split(sep).includes("data")) {
    throw new Error("fixtures must not be loaded from data/: that folder holds real chats");
  }
  return readdirSync(resolved)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const parsed = FixtureSchema.safeParse(JSON.parse(readFileSync(join(resolved, name), "utf8")));
      if (!parsed.success) throw new Error(`fixture ${name} is not valid: ${parsed.error.issues[0]?.message}`);
      return parsed.data;
    });
}

export function fixtureLabels(fixture: Fixture): SpeakerLabels {
  return { person_1: fixture.labels.person_1, person_2: fixture.labels.person_2 };
}

export function fixtureMessages(fixture: Fixture): ExtractionMessage[] {
  return fixture.messages.map((message) => {
    const parsed = parseLocal(message.at);
    if (!parsed || parsed.granularity !== "minute") throw new Error(`fixture ${fixture.name}: bad time "${message.at}"`);
    return {
      id: message.id,
      personId: message.who,
      sentAt: parsed.instant,
      text: message.text,
      source: SOURCES[message.source],
      kind: message.kind,
    };
  });
}

export type FixtureScore = {
  /** Expected events that were found: same category, shared evidence, same day. */
  matched: number;
  expected: number;
  /** Events found that match nothing expected. */
  extra: number;
  /** Events in a forbidden category. */
  forbidden: number;
  /** Matched events whose first claim disagrees with the fixture. */
  firstMismatches: number;
};

/** Compares a run's candidates with the fixture's expected events (already validated). */
export function scoreFixture(
  fixture: Fixture,
  expected: readonly Candidate[],
  actual: readonly Candidate[],
): FixtureScore {
  const used = new Set<number>();
  let matched = 0;
  let firstMismatches = 0;

  for (const want of expected) {
    const wantIds = new Set(want.evidence.map((entry) => entry.messageId));
    const index = actual.findIndex(
      (got, i) =>
        !used.has(i) &&
        got.category === want.category &&
        dayKey(got.occurredAt) === dayKey(want.occurredAt) &&
        got.evidence.some((entry) => wantIds.has(entry.messageId)),
    );
    if (index === -1) continue;
    used.add(index);
    matched++;
    if ((actual[index] as Candidate).isFirst !== want.isFirst) firstMismatches++;
  }

  return {
    matched,
    expected: expected.length,
    extra: actual.length - used.size,
    forbidden: actual.filter((event) => fixture.forbiddenCategories.includes(event.category)).length,
    firstMismatches,
  };
}
