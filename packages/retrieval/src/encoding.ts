import type { SQL } from "bun";
import { runRead, type ReadOptions } from "./query";
import { asCount } from "./rows";

const MOJIBAKE = String.raw`Ã.|â€|ðŸ`;

/**
 * Counts of stored text that still looks damaged. Returns counts only, never the text.
 * Replacement characters usually come from the export. A suspicious run looks like
 * mojibake that ingest did not repair. `notNfc` is text that is not in NFC.
 */
export async function encodingIssueCounts(
  sql: SQL,
  options: ReadOptions = {},
): Promise<{ replacementChar: number; suspiciousMojibake: number; notNfc: number }> {
  return runRead(sql, async (tx) => {
    const rows = (await tx.unsafe(
      `select
         count(*) filter (where position(chr(65533) in "text") > 0)::int as replacement,
         count(*) filter (where "text" ~ $1)::int as suspicious,
         count(*) filter (where "text" is distinct from normalize("text", NFC))::int as not_nfc
       from messages`,
      [MOJIBAKE],
    )) as { replacement: number; suspicious: number; not_nfc: number }[];
    const row = rows[0];
    return {
      replacementChar: asCount(row?.replacement ?? 0),
      suspiciousMojibake: asCount(row?.suspicious ?? 0),
      notNfc: asCount(row?.not_nfc ?? 0),
    };
  }, options);
}
