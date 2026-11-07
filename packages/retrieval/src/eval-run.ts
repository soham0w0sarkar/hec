import { readFileSync } from "node:fs";
import { createDb } from "@hec/db";
import { seedFixture } from "./fixture";
import { assertLocalTestDatabase, findFirst, type MatchMode } from "./index";

type Case = {
  id: string;
  text: string;
  mode: MatchMode;
  variants?: string[];
  expectSourceRef: string;
  expectPersonId: "person_1" | "person_2";
};

const url = process.env.RETRIEVAL_TEST_DATABASE_URL;
if (!url) {
  console.error("RETRIEVAL_TEST_DATABASE_URL is not set");
  process.exit(1);
}
assertLocalTestDatabase(url);

const file = JSON.parse(readFileSync(new URL("../../../evals/retrieval/cases.json", import.meta.url), "utf8")) as {
  synthetic?: boolean;
  cases: Case[];
};
if (file.synthetic !== true) {
  console.error("retrieval evals refuse a case file that is not marked synthetic");
  process.exit(1);
}

const sql = createDb(url, { max: 1 });
let failed = 0;
try {
  await sql`truncate messages, sessions restart identity cascade`;
  await seedFixture(sql);
  for (const item of file.cases) {
    const found = await findFirst(sql, { text: item.text, mode: item.mode, variants: item.variants });
    const ref = found.hit?.sourceRef ?? "none";
    const person = found.hit?.personId ?? "none";
    const ok = ref === item.expectSourceRef && person === item.expectPersonId;
    if (!ok) failed += 1;
    console.log(`${ok ? "pass" : "fail"} ${item.id} expected ${item.expectPersonId} ${item.expectSourceRef} got ${person} ${ref}`);
  }
  console.log(`${file.cases.length - failed}/${file.cases.length} passed`);
  if (failed > 0) process.exitCode = 1;
} finally {
  await sql`truncate messages, sessions restart identity cascade`;
  await sql.close();
}
