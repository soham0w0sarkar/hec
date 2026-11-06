import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type SQL } from "bun";
import { createDb } from "./client";
import { PEOPLE_NAMES_ENV, parseDisplayNames, syncPeopleNames } from "./people";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../migrations");

export async function migrate(sql: SQL): Promise<string[]> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  const appliedRows = await sql<{ version: string }[]>`SELECT version FROM schema_migrations`;
  const applied = new Set(appliedRows.map((row) => row.version));

  const newlyApplied: string[] = [];
  for (const file of files) {
    const version = file.slice(0, -".sql".length);
    if (applied.has(version)) continue;

    const body = await readFile(join(migrationsDir, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (version) VALUES (${version})`;
    });
    newlyApplied.push(version);
  }

  return newlyApplied;
}

if (import.meta.main) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  // Check the names before touching the schema, so a missing value fails with nothing applied.
  const names = parseDisplayNames(process.env[PEOPLE_NAMES_ENV]);

  const sql = createDb(connectionString, { max: 1 });
  try {
    const applied = await migrate(sql);
    if (applied.length === 0) {
      console.log("schema is current");
    } else {
      for (const version of applied) console.log(`applied ${version}`);
    }
    await syncPeopleNames(sql, names);
    console.log("people names set from PEOPLE_DISPLAY_NAMES");
  } finally {
    await sql.close();
  }
}
