import { z } from "zod";
import { LLM_PRECISIONS } from "./types";

/**
 * What the model must return. This only checks the shape. The domain rules (category, refs,
 * quotes, dates, significance range) are applied in validate.ts, so one bad event costs one
 * event and not a whole retry.
 */
export const RawEventSchema = z.object({
  category: z.string(),
  title: z.string(),
  summary: z.string(),
  /** `YYYY-MM-DD HH:mm` in the transcript's timezone. `YYYY-MM-DD` or `YYYY-MM` for coarser dates. */
  occurred_at: z.string(),
  date_precision: z.enum(LLM_PRECISIONS),
  ended_at: z.string().nullish(),
  significance: z.number(),
  is_first: z.boolean(),
  /** Short search words for the thing that happened "first". Required when `is_first` is true. */
  first_of: z.string().nullish(),
  evidence: z.array(z.object({ ref: z.string(), role: z.enum(["primary", "supporting"]) })),
  saying: z.object({ speaker: z.string(), quote: z.string() }).nullish(),
});
export type RawEvent = z.infer<typeof RawEventSchema>;

export const ExtractionOutputSchema = z.object({ events: z.array(RawEventSchema) });
export type ExtractionOutput = z.infer<typeof ExtractionOutputSchema>;

/** Models like to wrap JSON in a code fence. Strip it, then parse. Returns null on bad JSON. */
export function parseJsonReply(text: string): unknown {
  let body = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body);
  if (fenced) body = (fenced[1] as string).trim();
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** Describes a failed parse without echoing any values, so it is safe to log and to send back. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 10)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}
