// Runs the extraction fixtures. Synthetic chats only: nothing here reads data/.
//
//   bun run evals               offline: a perfect model's reply must pass every hard validator
//   bun run evals -- --live     live: asks the configured model (SARVAM_API_KEY, SARVAM_MODEL)
//
// Output has fixture names and counts only, never message text.
import {
  createExtractionModel,
  extractSession,
  fixtureLabels,
  fixtureMessages,
  loadFixtures,
  loadPrompt,
  scoreFixture,
  validateEvents,
  type ExtractionMessage,
  type Fixture,
} from "../../packages/extraction/src/index";
import type { ChatModel } from "../../packages/llm/src/index";

const live = process.argv.includes("--live");

/** A model that answers every window with the fixture's own expected events. */
function goldenModel(fixture: Fixture): ChatModel {
  return {
    model: "golden",
    complete: async () => ({
      text: JSON.stringify({ events: fixture.expected }),
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costInr: 0 },
    }),
  };
}

const prompt = loadPrompt();
const fixtures = loadFixtures();
const model = live ? createExtractionModel() : null;

let failed = false;
let matched = 0;
let expectedTotal = 0;
let extra = 0;
let cost = 0;

for (const fixture of fixtures) {
  const messages: ExtractionMessage[] = fixtureMessages(fixture);
  const labels = fixtureLabels(fixture);
  const context = { messages: new Map(messages.map((message) => [message.id, message])), labels };

  // What the fixture expects, after the same code checks as everything else.
  const checked = validateEvents(fixture.expected, context);
  if (checked.dropped.length > 0) {
    console.log(
      `FAIL ${fixture.name}: ${checked.dropped.length} expected event(s) fail validation (${checked.dropped.map((d) => d.reason).join(", ")})`,
    );
    failed = true;
    continue;
  }

  const result = await extractSession(model ?? goldenModel(fixture), prompt, messages, { labels });
  const score = scoreFixture(fixture, checked.candidates, result.candidates);
  matched += score.matched;
  expectedTotal += score.expected;
  extra += score.extra;
  cost += result.usage.costInr ?? 0;

  const bad = score.forbidden > 0 || (!live && (score.matched !== score.expected || score.extra > 0));
  failed ||= bad;
  console.log(
    `${bad ? "FAIL" : "ok  "} ${fixture.name}: matched ${score.matched}/${score.expected}, extra ${score.extra}, forbidden ${score.forbidden}, first mismatches ${score.firstMismatches}, dropped ${result.dropped.length}`,
  );
}

console.log(
  `\n${live ? "live run" : "offline check"}: matched ${matched}/${expectedTotal}, extra ${extra}, prompt ${prompt.version}${model ? `, model ${model.model}, cost ₹${cost.toFixed(4)}` : ""}`,
);
if (failed) process.exitCode = 1;
