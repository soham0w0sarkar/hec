import type { SQL } from "bun";
import { PERSON_IDS, type PersonId } from "@hec/core";

/** Env var holding a JSON object: { "<person id>": "<display name>" } for every person id. */
export const PEOPLE_NAMES_ENV = "PEOPLE_DISPLAY_NAMES";

export type DisplayNames = Record<PersonId, string>;

/** Reads the display names from `raw` (the env value). Fails if any person id is missing. */
export function parseDisplayNames(raw: string | undefined): DisplayNames {
  if (raw === undefined || raw.trim() === "") {
    throw new Error(`${PEOPLE_NAMES_ENV} is not set. Set it to JSON with a name for each of: ${PERSON_IDS.join(", ")}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${PEOPLE_NAMES_ENV} must be valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${PEOPLE_NAMES_ENV} must be a JSON object`);
  }

  const record = parsed as Record<string, unknown>;
  const names = {} as DisplayNames;
  for (const id of PERSON_IDS) {
    const name = record[id];
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error(`${PEOPLE_NAMES_ENV} needs a non-empty name for "${id}"`);
    }
    names[id] = name.trim();
  }

  const extra = Object.keys(record).filter((key) => !(PERSON_IDS as readonly string[]).includes(key));
  if (extra.length > 0) throw new Error(`${PEOPLE_NAMES_ENV} has unknown person ids: ${extra.join(", ")}`);

  if (new Set(Object.values(names)).size !== PERSON_IDS.length) {
    throw new Error(`${PEOPLE_NAMES_ENV} names must be different from each other`);
  }
  return names;
}

/** Writes the display names into `people`. The ids are fixed by the migration. */
export async function syncPeopleNames(sql: SQL, names: DisplayNames): Promise<void> {
  for (const id of PERSON_IDS) {
    const updated = await sql<{ id: string }[]>`
      update people set name = ${names[id]} where id = ${id} returning id
    `;
    if (updated.length !== 1) throw new Error(`people row "${id}" is missing`);
  }
}
