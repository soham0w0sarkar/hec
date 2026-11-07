import type { SQL } from "bun";
import { findFirst } from "@hec/retrieval";
import type { FirstLookup } from "./firsts";

/**
 * Phrase match only, so a fuzzy hit cannot become "the first time".
 * Pass `variants` when the caller has other spellings; they are OR-ed into the same query.
 * System, unsent, and empty lines are not searched.
 */
export function retrievalFirstLookup(sql: SQL): FirstLookup {
  return async ({ text, variants }) => {
    const found = await findFirst(sql, { text, variants, mode: "phrase" });
    return found.hit === null ? null : { messageId: found.hit.id, sentAt: found.hit.sentAt };
  };
}
