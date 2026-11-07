import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  FIXTURE_ID_FLOOR,
  defaultFixturesDir,
  fixtureLabels,
  fixtureMessages,
  loadFixtures,
  scoreFixture,
} from "./fixtures";
import { extractSession } from "./extract";
import { loadPrompt } from "./prompt";
import { validateEvents } from "./validate";

const fixtures = loadFixtures();
const repoRoot = join(defaultFixturesDir(), "../../..");

describe("fixtures", () => {
  test("there is a set, covering plan vs meetup, empty sessions, a saying, a first and a trip", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(8);
    expect(fixtures.some((f) => f.expected.length === 0)).toBe(true);
    const categories = new Set(fixtures.flatMap((f) => f.expected.map((e) => e.category)));
    for (const c of ["Plan", "Meetup", "Trip", "Saying", "Milestone", "Conflict", "Life update", "Celebration"]) {
      expect(categories.has(c)).toBe(true);
    }
  });

  test("every fixture is marked synthetic, uses invented ids and years in the future", () => {
    for (const fixture of fixtures) {
      expect(fixture.synthetic).toBe(true);
      for (const message of fixture.messages) {
        expect(message.id).toBeGreaterThanOrEqual(FIXTURE_ID_FLOOR);
        expect(message.at.startsWith("20")).toBe(true);
        expect(Number(message.at.slice(0, 4))).toBeGreaterThanOrEqual(2030);
      }
    }
  });

  test("a perfect model's reply passes every hard validator, and the pipeline scores it perfectly", async () => {
    for (const fixture of fixtures) {
      const messages = fixtureMessages(fixture);
      const labels = fixtureLabels(fixture);
      const context = { messages: new Map(messages.map((m) => [m.id, m])), labels };
      const checked = validateEvents(fixture.expected, context);
      expect(checked.dropped).toEqual([]);

      const result = await extractSession(
        {
          model: "golden",
          complete: async () => ({
            text: JSON.stringify({ events: fixture.expected }),
            usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costInr: 0 },
          }),
        },
        loadPrompt(),
        messages,
        { labels },
      );
      const score = scoreFixture(fixture, checked.candidates, result.candidates);
      expect(score).toEqual({ matched: fixture.expected.length, expected: fixture.expected.length, extra: 0, forbidden: 0, firstMismatches: 0 });
    }
  });

  test("expected events never use a forbidden category", () => {
    for (const fixture of fixtures) {
      for (const event of fixture.expected) expect(fixture.forbiddenCategories).not.toContain(event.category);
    }
  });

  test("the scorer notices a missed event, an extra event and a forbidden one", () => {
    const fixture = fixtures.find((f) => f.name === "plan only")!;
    const messages = fixtureMessages(fixture);
    const context = { messages: new Map(messages.map((m) => [m.id, m])), labels: fixtureLabels(fixture) };
    const expected = validateEvents(fixture.expected, context).candidates;
    const trip = validateEvents([{ ...fixture.expected[0]!, category: "Trip" }], context).candidates;
    expect(scoreFixture(fixture, expected, [])).toMatchObject({ matched: 0, expected: 1 });
    expect(scoreFixture(fixture, expected, [...expected, ...trip])).toMatchObject({ matched: 1, extra: 1, forbidden: 1 });
  });

  test("the loader refuses a folder under data/", () => {
    expect(() => loadFixtures(join(repoRoot, "data", "review"))).toThrow(/data/);
  });
});

describe("privacy", () => {
  test("fixtures do not point at real data", () => {
    const dir = defaultFixturesDir();
    for (const name of readdirSync(dir)) {
      const text = readFileSync(join(dir, name), "utf8");
      expect(text).not.toMatch(/data\/(raw|review)/);
      expect(text).not.toMatch(/PEOPLE_DISPLAY_NAMES|source_identities/);
    }
  });

  test(".gitignore ignores everything under data/ except the .gitkeep files", () => {
    const ignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");
    expect(ignore).toContain("data/**");
    expect(ignore).toContain("!data/**/.gitkeep");
  });

  test("git tracks nothing under data/ but .gitkeep", () => {
    let tracked: string[];
    try {
      tracked = execFileSync("git", ["ls-files", "data"], { cwd: repoRoot, encoding: "utf8" }).split("\n").filter(Boolean);
    } catch {
      return; // not a git checkout, nothing to check
    }
    expect(tracked.filter((path) => !path.endsWith(".gitkeep"))).toEqual([]);
  });
});
