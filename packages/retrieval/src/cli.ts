import { createDb } from "@hec/db";
import { MATCH_MODES, type MatchMode } from "./types";
import { searchMessages } from "./keyword";

const USAGE = "usage: bun run search -- [--mode phrase|any_word|fuzzy] [--limit N] [--after CURSOR] <words>";

if (import.meta.main) {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === null) {
    console.error(USAGE);
    process.exitCode = 1;
  } else {
    const sql = createDb(process.env.DATABASE_URL, { max: 1 });
    try {
      const page = await searchMessages(sql, {
        text: parsed.text,
        mode: parsed.mode,
        limit: parsed.limit,
        after: parsed.after,
      });
      const from = page.hits.length === 0 ? 0 : 1;
      console.log(`${page.mode}: ${page.total} matches, showing ${from}-${page.hits.length}`);
      for (const hit of page.hits) {
        const quote = hit.text.replace(/\s+/g, " ").slice(0, 80);
        console.log(`${hit.sentAt.toISOString()} ${hit.personId} ${hit.source} ${hit.kind} ${quote}`);
      }
      if (page.next) {
        console.log(`next: bun run search -- --after '${page.next}' ${parsed.words.join(" ")}`);
      }
    } finally {
      await sql.close();
    }
  }
}

/** Returns null when the arguments are unusable. */
export function parseArgs(
  argv: string[],
): { text: string; words: string[]; mode: MatchMode; limit?: number; after?: string } | null {
  const words: string[] = [];
  let limit: number | undefined;
  let after: string | undefined;
  let mode: MatchMode = "phrase";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") continue;
    if (arg === "--limit") {
      limit = Number(argv[++i]);
      if (!Number.isInteger(limit)) return null;
    } else if (arg === "--after") {
      after = argv[++i];
      if (after === undefined) return null;
    } else if (arg === "--mode") {
      const value = argv[++i];
      if (value === undefined || !(MATCH_MODES as readonly string[]).includes(value)) return null;
      mode = value as MatchMode;
    } else {
      words.push(arg);
    }
  }

  const text = words.join(" ").trim();
  if (text === "") return null;
  return { text, words, mode, limit, after };
}
