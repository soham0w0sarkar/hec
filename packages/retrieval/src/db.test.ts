import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, type Database } from "@hec/db";
import { memoryRetrievalCache } from "./cache";
import { getContextAround, getDayTranscript } from "./context";
import { encodingIssueCounts } from "./encoding";
import { RetrievalError } from "./errors";
import { FIXTURE_MODEL, basisVector, seedFixture } from "./fixture";
import { assertLocalTestDatabase } from "./guard";
import { hybridSearch } from "./hybrid";
import { countMatches, findFirst, findLast, matchesPerPeriod, searchMessages } from "./keyword";
import { runRead } from "./query";
import { busiestDays, callCounts, streaks, whoMessagesFirst } from "./stats";
import { listEvents } from "./events";
import { searchChunks } from "./vector";

const url = process.env.RETRIEVAL_TEST_DATABASE_URL;
if (url !== undefined) assertLocalTestDatabase(url);

const describeDb = url ? describe : describe.skip;

describeDb("retrieval against the local test database", () => {
  // describe.skip still evaluates this callback. Do not open a connection unless the test URL is set.
  const sql: Database = url ? createDb(url, { max: 1 }) : (undefined as unknown as Database);

  beforeAll(async () => {
    await reset(sql);
    await seedFixture(sql);
  });

  afterAll(async () => {
    await reset(sql);
    await sql.close();
  });

  test("phrase 'love you' prefers the tighter fold and keeps the original text", async () => {
    const found = await findFirst(sql, { text: "love you", mode: "phrase", runnersUp: 5 });
    expect(found.hit?.sourceRef).toBe("ig:loveee");
    expect(found.hit?.form).toBe("one");
    expect(found.hit?.match).toBe("exact");
    expect(found.hit?.text).toBe("loveee youuu");
    expect(found.hit?.name).toBe("Ravi");
    expect(found.hit?.sentAtIst).toBe("2030-06-01 10:00:00");
    expect(found.runnersUp.map((hit) => hit.sourceRef)).toContain("ig:love");
    expect(found.runnersUp.find((hit) => hit.sourceRef === "ig:love")?.form).toBe("two");
    expect(found.runnersUp.map((hit) => hit.sourceRef)).not.toContain("ig:lovee");
    expect(found.total).toBe(2);
  });

  test("findFirst matches the earliest row of a full scan, and the count matches that scan", async () => {
    const first = await findFirst(sql, { text: "love", mode: "any_word" });
    const page = await searchMessages(sql, { text: "love", mode: "any_word", limit: 100 });
    const counted = await countMatches(sql, { text: "love", mode: "any_word" });
    expect(first.hit?.id).toBe(page.hits[0]?.id);
    expect(first.total).toBe(page.total);
    expect(counted.total).toBe(page.hits.length);
    expect(page.hits.map((hit) => hit.sourceRef)).toContain("ig:zw");
    expect(page.hits.find((hit) => hit.sourceRef === "ig:zw")?.text).toBe("lo\u200Bve");

    const seen: string[] = [];
    let after: string | undefined;
    for (let pages = 0; pages < 20; pages++) {
      const batch = await searchMessages(sql, { text: "love", mode: "any_word", limit: 2, after });
      seen.push(...batch.hits.map((hit) => hit.sourceRef));
      if (!batch.next) break;
      after = batch.next;
    }
    expect(seen).toEqual(page.hits.map((hit) => hit.sourceRef));
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("the same timestamp orders by source, then source ref", async () => {
    const page = await searchMessages(sql, { text: "same instant", mode: "phrase", limit: 10 });
    expect(page.hits.map((hit) => `${hit.source}:${hit.sourceRef}`)).toEqual([
      "instagram:tie-a",
      "instagram:tie-b",
      "whatsapp:tie-a",
    ]);
    const again = await searchMessages(sql, { text: "same instant", mode: "phrase", limit: 10 });
    expect(again.hits.map((hit) => hit.id)).toEqual(page.hits.map((hit) => hit.id));
  });

  test("emoji, a heart with a variation selector, and fuzzy typos", async () => {
    const emoji = await searchMessages(sql, { text: "😂", mode: "phrase" });
    expect(emoji.hits.map((hit) => hit.sourceRef)).toEqual(["ig:morning"]);
    expect(emoji.hits[0]?.text).toBe("good morning 😂");

    const heart = await searchMessages(sql, { text: "❤️", mode: "phrase" });
    expect(heart.hits.map((hit) => hit.sourceRef)).toEqual(["ig:heart"]);
    expect(heart.hits[0]?.text).toBe("heart \u2764");

    const typo = await searchMessages(sql, { text: "lovve", mode: "fuzzy" });
    expect(typo.mode).toBe("fuzzy");
    expect(typo.hits.length).toBeGreaterThan(0);
    expect(typo.hits.every((hit) => hit.match === "fuzzy" && hit.score >= 0.5)).toBe(true);

    const slang = await findFirst(sql, { text: "luv", mode: "fuzzy" });
    expect(slang.hit?.sourceRef).toBe("wa:luv");

    const none = await searchMessages(sql, { text: "zzzzqqqxxx", mode: "fuzzy" });
    expect(none).toEqual({ mode: "fuzzy", total: 0, hits: [], next: null });
  });

  test("variants are one query and do not duplicate a message", async () => {
    const page = await searchMessages(sql, { text: "love you", mode: "phrase", variants: ["luv u"], limit: 20 });
    const refs = page.hits.map((hit) => hit.sourceRef);
    expect(refs).toContain("ig:love");
    expect(refs).toContain("wa:luv");
    expect(new Set(refs).size).toBe(refs.length);
  });

  test("hostile text matches nothing and does not throw", async () => {
    const hostile = `a' & !b | (c:* <-> \\\\d) "e"`;
    const page = await searchMessages(sql, { text: hostile, mode: "phrase" });
    expect(page.total).toBe(0);
    await expect(searchMessages(sql, { text: "", mode: "any_word" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  test("system, unsent, and empty messages are left out unless asked for", async () => {
    const hidden = await searchMessages(sql, { text: "system line about the chat", mode: "phrase" });
    expect(hidden.total).toBe(0);
    const shown = await searchMessages(sql, {
      text: "system line about the chat",
      mode: "phrase",
      kinds: ["system"],
    });
    expect(shown.hits.map((hit) => hit.sourceRef)).toEqual(["wa:system"]);

    const day = await getDayTranscript(sql, "2030-06-04");
    expect(day.hits.map((hit) => hit.sourceRef)).not.toContain("ig:empty");
    expect(day.hits.map((hit) => hit.sourceRef)).not.toContain("ig:unsent");
    expect(day.hits.map((hit) => hit.sourceRef)).not.toContain("wa:system");
    const withEmpty = await getDayTranscript(sql, "2030-06-04", { includeEmpty: true, kinds: ["text"] });
    expect(withEmpty.hits.map((hit) => hit.sourceRef)).toContain("ig:empty");
    expect(withEmpty.hits.find((hit) => hit.sourceRef === "ig:empty")?.text).toBe("");
  });

  test("23:50 IST belongs to that day, and filters are inclusive at from and exclusive at until", async () => {
    const first = await getDayTranscript(sql, "2030-06-01", { limit: 20 });
    expect(first.hits.map((hit) => hit.sourceRef)).toContain("wa:milte");
    expect(first.hits.map((hit) => hit.sourceRef)).not.toContain("ig:morning");
    const second = await getDayTranscript(sql, "2030-06-02", { limit: 20 });
    expect(second.hits.map((hit) => hit.sourceRef)).toContain("ig:morning");

    const ranged = await searchMessages(sql, {
      text: "love",
      mode: "any_word",
      from: new Date("2030-06-01T04:30:00.000Z"),
      until: new Date("2030-06-01T04:36:00.000Z"),
    });
    expect(ranged.hits.map((hit) => hit.sourceRef)).toEqual(["ig:loveee", "ig:love"]);
    const hers = await searchMessages(sql, { text: "love you", mode: "phrase", personId: "person_2" });
    expect(hers.hits.every((hit) => hit.personId === "person_2")).toBe(true);
  });

  test("context crosses apps, and the latest match is the last one", async () => {
    const day = await getDayTranscript(sql, "2030-06-01", { limit: 20 });
    const milte = day.hits.find((hit) => hit.sourceRef === "wa:milte");
    if (!milte) throw new Error("expected the late WhatsApp message");
    const around = await getContextAround(sql, milte.id, 1, 1);
    expect(around.messages.map((hit) => hit.sourceRef)).toEqual(["ig:lovee", "wa:milte", "ig:morning"]);
    const last = await findLast(sql, { text: "love", mode: "any_word", runnersUp: 1 });
    expect(last.hit?.sourceRef).toBe("ig:zw");
    expect(last.runnersUp).toHaveLength(1);
  });

  test("match counts per day agree with the pages", async () => {
    const periods = await matchesPerPeriod(sql, { text: "love", mode: "any_word", period: "day" });
    const page = await searchMessages(sql, { text: "love", mode: "any_word", limit: 100 });
    const byDay = new Map<string, number>();
    for (const hit of page.hits) byDay.set(hit.sentAtIst.slice(0, 10), (byDay.get(hit.sentAtIst.slice(0, 10)) ?? 0) + 1);
    expect(periods.truncated).toBe(false);
    expect(Object.fromEntries(periods.periods.map((row) => [row.period, row.count]))).toEqual(Object.fromEntries(byDay));
  });

  test("stats come from daily_stats, and a lagged view is refreshed", async () => {
    try {
    const busy = await busiestDays(sql, { limit: 5 });
    expect(busy.days[0]?.day).toBe("2030-06-02");
    const calls = await callCounts(sql);
    expect(calls.calls).toBe(1);
    const run = await streaks(sql);
    expect(run.longest).toBe(5);
    expect(run.longestFrom).toBe("2030-06-01");
    expect(run.current).toBe(5);
    const firstSender = await whoMessagesFirst(sql);
    expect(firstSender.days).toEqual([{ personId: "person_1", days: 5 }]);

    await sql`
      insert into messages (person_id, sent_at, "text", source, source_ref, kind)
      values ('person_2', '2030-06-06T04:30:00.000Z', 'later call', 'whatsapp', 'wa:later-call', 'call')
    `;
    await sql`update app_settings set stats_version = data_version where id = 1`;
    const stale = await callCounts(sql);
    expect(stale.calls).toBe(1);
    await sql`update app_settings set stats_version = data_version - 1 where id = 1`;
    const fresh = await callCounts(sql);
    expect(fresh.calls).toBe(2);
  } finally {
    await reset(sql);
    await seedFixture(sql);
  }
  });

  test("chunk search filters inside the query and refuses a different model", async () => {
    const morning = await searchChunks(sql, { vector: basisVector(0), model: FIXTURE_MODEL, limit: 5 });
    expect(morning.hits.every((hit) => hit.model === FIXTURE_MODEL)).toBe(true);
    expect(morning.hits[0]?.transcript).toContain("morning");
    const whatsapp = await searchChunks(sql, { vector: basisVector(0), model: FIXTURE_MODEL, source: "whatsapp", limit: 5 });
    expect(whatsapp.hits.map((hit) => hit.transcript)).toEqual(["Anita on WhatsApp, late 1 June 2030"]);
    await expect(searchChunks(sql, { vector: basisVector(0), model: "missing-model" })).rejects.toMatchObject({
      code: "model_mismatch",
    });
  });

  test("hybrid marks which method found the hit", async () => {
    const fused = await hybridSearch(sql, {
      text: "love you",
      mode: "phrase",
      vector: basisVector(0),
      model: FIXTURE_MODEL,
      limit: 10,
    });
    expect(fused.hits.some((hit) => hit.via.includes("keyword") && hit.via.includes("vector"))).toBe(true);
    expect(fused.hits.every((hit) => hit.message === null || hit.message.text.length >= 0)).toBe(true);
  });

  test("a repeated query is served from the cache until the data version changes", async () => {
    const cache = memoryRetrievalCache();
    const search = { text: "milte", mode: "phrase" as const };
    await searchMessages(sql, search, { cache });
    await searchMessages(sql, search, { cache });
    expect(cache.writes).toBe(1);
    expect(cache.reads).toBe(2);
    await sql`select bump_data_version()`;
    await searchMessages(sql, search, { cache });
    expect(cache.writes).toBe(2);
  });

  test("encoding issues are counted and the text is not returned", async () => {
    const counts = await encodingIssueCounts(sql);
    expect(counts.replacementChar).toBeGreaterThan(0);
    expect(counts.suspiciousMojibake).toBeGreaterThan(0);
    expect(counts.notNfc).toBeGreaterThan(0);
    expect(JSON.stringify(counts)).not.toContain("caf");
  });

  test("the keyword and chunk indexes are usable", async () => {
    const keywordPlan = await explain(sql, "enable_seqscan", `
      select m.id from messages m
      where m.search_vector_two @@ phraseto_tsquery('simple', 'love you')
      order by m.sent_at, m.source, m.source_ref
      limit 5`);
    expect(keywordPlan).toContain("messages_search_vector_two");

    const vector = `[${basisVector(0).join(",")}]`;
    const chunkPlan = await explain(sql, "enable_seqscan", `
      select c.id from chunks c
      where c.embedding_model = 'text-embedding-3-small'
      order by c.embedding <=> '${vector}'::vector
      limit 2`);
    expect(chunkPlan).toContain("chunks_embedding_hnsw");
  });

  test("listEvents returns approved and edited rows in time order and hides drafts", async () => {
    const love = (await sql`select id from messages where source_ref = 'ig:loveee'`) as { id: string | number }[];
    const messageId = love[0]?.id;
    if (messageId === undefined) throw new Error("fixture message is missing");
    const runs = (await sql`
      insert into extraction_runs (model, prompt_version, status, finished_at)
      values ('fixture', 'extract.v1', 'succeeded', now())
      returning id
    `) as { id: string | number }[];
    const runId = runs[0]?.id;
    if (runId === undefined) throw new Error("fixture run was not created");
    try {
      const inserted = (await sql`
        insert into events (
          title, summary, category, occurred_at, date_precision, status, extraction_run_id,
          significance, is_first, speaker_id, quote
        ) values
          ('Cafe', 'They picked a cafe.', 'Meetup', '2030-06-01T04:30:00Z', 'exact_day', 'approved', ${runId}, 1, false, null, null),
          ('Argument', 'They argued and left it.', 'Conflict', '2030-06-03T04:00:00Z', 'exact_day', 'approved', ${runId}, 2, false, null, null),
          ('Hidden', 'A draft nobody reviewed.', 'Plan', '2030-06-02T04:00:00Z', 'exact_day', 'draft', ${runId}, 1, false, null, null),
          ('Line', 'A line worth keeping.', 'Saying', '2030-06-04T04:00:00Z', 'exact_day', 'edited', ${runId}, 1, false, 'person_2', 'keep this line')
        returning id, category
      `) as { id: string | number; category: string }[];
      const conflict = inserted.find((row) => row.category === "Conflict");
      if (!conflict) throw new Error("conflict event is missing");
      await sql`insert into event_evidence (event_id, message_id, role) values (${conflict.id}, ${messageId}, 'primary')`;

      const page = await listEvents(sql, { limit: 2 });
      expect(page.events.map((event) => event.category)).toEqual(["Meetup", "Conflict"]);
      expect(page.events.map((event) => event.status)).toEqual(["approved", "approved"]);
      expect(page.events[0]?.occurredAtIst.startsWith("2030-06-01")).toBe(true);
      expect(page.events[1]?.evidenceMessageIds).toEqual([Number(messageId)]);
      expect(page.next).not.toBeNull();

      const rest = await listEvents(sql, { limit: 2, after: page.next ?? undefined });
      expect(rest.events.map((event) => event.category)).toEqual(["Saying"]);
      expect(rest.events[0]?.quote).toBe("keep this line");
      expect(rest.events[0]?.speakerId).toBe("person_2");
      expect(rest.next).toBeNull();

      const onlyConflict = await listEvents(sql, { category: "Conflict" });
      expect(onlyConflict.events.map((event) => event.title)).toEqual(["Argument"]);
    } finally {
      await sql`delete from event_evidence`;
      await sql`delete from events`;
      await sql`delete from extraction_runs`;
    }
  });

  test("a statement that overruns the timeout becomes a timeout error", async () => {
    await expect(runRead(sql, async (tx) => tx`select pg_sleep(1)`, { timeoutMs: 200 })).rejects.toMatchObject({
      code: "timeout",
    });
  });
});

async function reset(sql: Database): Promise<void> {
  await sql`truncate messages, sessions restart identity cascade`;
  await sql`select refresh_daily_stats()`;
}

async function explain(sql: Database, setting: string, statement: string): Promise<string> {
  const rows = await sql.begin(async (tx) => {
    await tx.unsafe(`select set_config($1, 'off', true)`, [setting]);
    return tx.unsafe(`explain ${statement}`) as Promise<{ "QUERY PLAN": string }[]>;
  });
  return rows.map((row) => row["QUERY PLAN"]).join("\n");
}
