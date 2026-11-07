import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createDb } from "@hec/db";
import type { ChatModel } from "@hec/llm";
import { neutralText, render } from "@hec/persona";
import { assertLocalTestDatabase, countMatches } from "@hec/retrieval";
import type { SQL } from "bun";
import type { MessageKind, MessageSource, PersonId } from "@hec/core";
import { seedFixture } from "../../retrieval/src/fixture";
import { planner } from "./eval-planner";
import { runAgent } from "./run";

type Case = {
  id: string;
  question: string;
  expectVerdict: "found" | "not_found" | "ambiguous" | "partial";
  expectSourceRef?: string;
  expectSourceRefs?: string[];
  expectPersonId?: "person_1" | "person_2";
  expectVariants?: string[];
  expectSensitivity?: "none" | "heavy";
  expectDate?: string;
  forbid?: string;
};

const fileUrl = new URL("../../../evals/agent/cases.json", import.meta.url);
const file = JSON.parse(readFileSync(fileUrl, "utf8")) as { synthetic?: boolean; cases: Case[] };
if (file.synthetic !== true) {
  console.error("agent evals refuse a case file that is not marked synthetic");
  process.exit(1);
}
assertNoExportPaths(new URL("../../../evals/", import.meta.url));

const url = process.env.RETRIEVAL_TEST_DATABASE_URL;
if (!url) {
  console.error("RETRIEVAL_TEST_DATABASE_URL is not set");
  process.exit(1);
}
assertLocalTestDatabase(url);

const sql = createDb(url, { max: 1 });
const zero = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costInr: 0 };
let failed = 0;

try {
  await cleanup();
  await seedFixture(sql);
  await seedExtra(sql);
  const refs = new Map<number, { sourceRef: string; personId: string }>();
  const rows = (await sql`select id, source_ref, person_id from messages`) as {
    id: string | number;
    source_ref: string;
    person_id: string;
  }[];
  for (const row of rows) refs.set(Number(row.id), { sourceRef: row.source_ref, personId: row.person_id });

  for (const item of file.cases) {
    const result = await runAgent(
      { question: item.question, runId: item.id },
      { sql, model: planner(item.id), embedder: null, chunksModel: null },
    );
    const payload = result.payload;
    const reasons: string[] = [];
    if (payload.verdict !== item.expectVerdict) reasons.push(`verdict ${payload.verdict}`);
    if (item.expectSensitivity && payload.sensitivity !== item.expectSensitivity) reasons.push(`sensitivity ${payload.sensitivity}`);
    if (item.expectDate && !payload.claims.some((claim) => claim.date === item.expectDate)) reasons.push("date missing");
    for (const variant of item.expectVariants ?? []) {
      if (!payload.searched.variants.includes(variant)) reasons.push(`variant ${variant} missing`);
    }
    const cited = payload.claims.flatMap((claim) => claim.message_ids);
    const citedRefs = cited.flatMap((id) => {
      const row = refs.get(id);
      return row ? [row] : [];
    });
    if (item.expectSourceRef && !citedRefs.some((row) => row.sourceRef === item.expectSourceRef)) {
      reasons.push(`source ref ${item.expectSourceRef} missing`);
    }
    for (const ref of item.expectSourceRefs ?? []) {
      if (!citedRefs.some((row) => row.sourceRef === ref)) reasons.push(`source ref ${ref} missing`);
    }
    if (item.expectPersonId && !citedRefs.some((row) => row.personId === item.expectPersonId)) {
      reasons.push(`person ${item.expectPersonId} missing`);
    }
    if (item.id === "how-many-hellos") {
      const counted = await countMatches(sql, { text: "hello", mode: "phrase" });
      const text = payload.claims.map((claim) => claim.text).join(" ");
      if (!text.includes(String(counted.total))) reasons.push("count does not match retrieval");
    }
    const rendered = await render(payload, "neutral");
    const dumped = JSON.stringify(payload) + rendered.text;
    if (item.forbid && dumped.includes(item.forbid)) reasons.push("forbidden text present");
    const calls = result.toolCalls;
    if (item.id === "who-said-hello-first") {
      const voices = await Promise.all([
        render(payload, "neutral"),
        render(payload, "romance_geek", { model: faithful(`Noted in the archives.\n${neutralText(payload)}`) }),
        render(payload, { id: "extreme", system: "Dramatic, but facts only." }, { model: faithful(`MAXIMUM DRAMA.\n${neutralText(payload)}`) }),
      ]);
      const facts = voices.map((voice) => JSON.stringify(voice.facts));
      if (facts[0] !== facts[1] || facts[0] !== facts[2]) reasons.push("persona changed the facts");
      if (result.toolCalls !== calls) reasons.push("persona triggered a tool call");
    }
    if (item.id === "conflict-is-heavy") {
      const soft = await render(payload, "romance_geek", { model: faithful("What a plot twist 😉") });
      if (/plot twist|😉/.test(soft.text)) reasons.push("soft mode kept a joke");
      if (item.expectDate && !soft.text.includes(item.expectDate)) reasons.push("soft render dropped the date");
    }
    console.log(`${reasons.length === 0 ? "pass" : "fail"} ${item.id} verdict ${payload.verdict} sensitivity ${payload.sensitivity}`);
    for (const reason of reasons) console.log(`  ${reason}`);
    if (reasons.length > 0) failed += 1;
  }
  console.log(`${file.cases.length - failed}/${file.cases.length} passed`);
  if (failed > 0) process.exitCode = 1;
} finally {
  await cleanup();
  await sql.close();
}

type ExtraMessage = {
  personId: PersonId;
  sentAt: string;
  text: string;
  source: MessageSource;
  sourceRef: string;
  kind: MessageKind;
};

async function seedExtra(sql: SQL): Promise<void> {
  const file = JSON.parse(readFileSync(new URL("../../../evals/agent/messages.json", import.meta.url), "utf8")) as {
    synthetic?: boolean;
    messages: ExtraMessage[];
  };
  if (file.synthetic !== true) throw new Error("agent eval messages are not marked synthetic");
  const sessions = (await sql`select id from sessions order by id desc limit 1`) as { id: string | number }[];
  const sessionId = sessions[0]?.id;
  if (sessionId === undefined) throw new Error("fixture session is missing");
  for (const message of file.messages) {
    await sql`
      insert into messages (person_id, sent_at, "text", source, source_ref, kind, session_id)
      values (
        ${message.personId},
        ${message.sentAt}::timestamptz,
        ${message.text},
        ${message.source}::message_source,
        ${message.sourceRef},
        ${message.kind}::message_kind,
        ${sessionId}
      )
    `;
  }
  const argue = (await sql`select id from messages where source_ref = 'wa:argue'`) as { id: string | number }[];
  const messageId = argue[0]?.id;
  if (messageId === undefined) throw new Error("fixture argument is missing");
  const runs = (await sql`
    insert into extraction_runs (model, prompt_version, status, finished_at)
    values ('eval-fixture', 'extract.v1', 'succeeded', now())
    returning id
  `) as { id: string | number }[];
  const runId = runs[0]?.id;
  if (runId === undefined) throw new Error("fixture run was not created");
  const events = (await sql`
    insert into events (
      title, summary, category, occurred_at, date_precision, status, extraction_run_id, significance, is_first
    ) values (
      'Argument', 'They argued about a plan.', 'Conflict', '2030-07-05T04:00:00Z', 'exact_day', 'approved', ${runId}, 2, false
    )
    returning id
  `) as { id: string | number }[];
  const eventId = events[0]?.id;
  if (eventId === undefined) throw new Error("fixture event was not created");
  await sql`insert into event_evidence (event_id, message_id, role) values (${eventId}, ${messageId}, 'primary')`;
  await sql`select refresh_daily_stats()`;
}

function faithful(text: string): ChatModel {
  return {
    model: "faithful",
    async complete() {
      return { text, usage: zero };
    },
  };
}

async function cleanup(): Promise<void> {
  await sql`delete from event_evidence`;
  await sql`delete from events`;
  await sql`delete from extraction_session_results`;
  await sql`delete from extraction_runs`;
  await sql`truncate messages, sessions restart identity cascade`;
}

function assertNoExportPaths(root: URL): void {
  const needles = ["raw", "review", "ingest.json"].map((part) => ["data", part].join("/"));
  const folder = root.pathname;
  for (const path of walk(folder)) {
    const text = readFileSync(path, "utf8");
    for (const needle of needles) {
      if (text.includes(needle)) {
        console.error(`agent evals refuse a file that references ${needle}`);
        process.exit(1);
      }
    }
  }
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".turbo") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.(ts|json|md)$/.test(name)) out.push(path);
  }
  return out;
}
