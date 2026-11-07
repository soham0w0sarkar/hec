import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const root = new URL("../../../", import.meta.url).pathname;
const needles = ["raw", "review", "ingest.json"].map((part) => ["data", part].join("/"));

describe("privacy", () => {
  test("agent, persona, and evals do not reference export paths", () => {
    const roots = ["packages/agent", "packages/persona", "evals"].map((dir) => join(root, dir));
    const hits: string[] = [];
    for (const dir of roots) {
      for (const path of walk(dir)) {
        const text = readFileSync(path, "utf8");
        for (const needle of needles) {
          if (text.includes(needle)) hits.push(`${path} ${needle}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});

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
