import { z } from "zod";
import { EVENT_CATEGORIES, MESSAGE_KINDS, MESSAGE_SOURCES, PERSON_IDS } from "@hec/core";

/** Agent-side caps. Retrieval allows more. The model cannot raise these. */
export const TOOL_LIMIT = 20;
export const TOOL_RUNNERS = 5;
export const TOOL_CONTEXT = 10;
export const TOOL_DAY_LIMIT = 40;
export const TOOL_STATS_LIMIT = 10;
export const TOOL_VARIANTS = 8;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const instant = z
  .string()
  .max(40)
  .refine((value) => DAY.test(value.slice(0, 10)) && !Number.isNaN(new Date(value).getTime()), { message: "bad time" });

const day = z.string().regex(DAY, "bad day");

const filters = {
  person_id: z.enum(PERSON_IDS).optional(),
  source: z.enum(MESSAGE_SOURCES).optional(),
  from: instant.optional(),
  until: instant.optional(),
  kinds: z.array(z.enum(MESSAGE_KINDS)).min(1).max(MESSAGE_KINDS.length).optional(),
};

const match = z
  .object({
    text: z.string().min(1).max(300),
    mode: z.enum(["phrase", "any_word", "fuzzy"]),
    variants: z.array(z.string().min(1).max(80)).max(TOOL_VARIANTS).optional(),
    ...filters,
  })
  .strict();

export const findSchema = match
  .extend({ runners_up: z.number().int().min(0).max(TOOL_RUNNERS).optional() })
  .strict();

export const keywordSchema = match.extend({ limit: z.number().int().min(1).max(TOOL_LIMIT).optional() }).strict();

export const periodSchema = match
  .extend({ period: z.enum(["day", "week", "month"]) })
  .strict();

export const semanticSchema = z
  .object({
    text: z.string().min(1).max(300),
    limit: z.number().int().min(1).max(10).optional(),
    from: instant.optional(),
    until: instant.optional(),
    person_id: z.enum(PERSON_IDS).optional(),
    source: z.enum(MESSAGE_SOURCES).optional(),
  })
  .strict();

export const contextSchema = z
  .object({
    message_id: z.number().int().positive(),
    before: z.number().int().min(0).max(TOOL_CONTEXT),
    after: z.number().int().min(0).max(TOOL_CONTEXT),
    person_id: z.enum(PERSON_IDS).optional(),
    source: z.enum(MESSAGE_SOURCES).optional(),
    kinds: z.array(z.enum(MESSAGE_KINDS)).min(1).max(MESSAGE_KINDS.length).optional(),
  })
  .strict();

export const daySchema = z
  .object({
    day,
    limit: z.number().int().min(1).max(TOOL_DAY_LIMIT).optional(),
    person_id: z.enum(PERSON_IDS).optional(),
    source: z.enum(MESSAGE_SOURCES).optional(),
    kinds: z.array(z.enum(MESSAGE_KINDS)).min(1).max(MESSAGE_KINDS.length).optional(),
  })
  .strict();

export const statsSchema = z
  .object({
    stat: z.enum(["busiest_days", "streaks", "who_messages_first", "call_counts", "counts_per_period"]),
    person_id: z.enum(PERSON_IDS).optional(),
    source: z.enum(MESSAGE_SOURCES).optional(),
    from_day: day.optional(),
    until_day: day.optional(),
    period: z.enum(["day", "week", "month"]).optional(),
    limit: z.number().int().min(1).max(TOOL_STATS_LIMIT).optional(),
  })
  .strict();

export const eventsSchema = z
  .object({
    category: z.enum(EVENT_CATEGORIES).optional(),
    from: instant.optional(),
    until: instant.optional(),
    limit: z.number().int().min(1).max(TOOL_LIMIT).optional(),
    after: z.string().min(1).max(200).optional(),
  })
  .strict();

export const TOOL_NAMES = [
  "find_first",
  "find_last",
  "count_matches",
  "matches_per_period",
  "keyword_search",
  "semantic_search",
  "hybrid_search",
  "get_context_around",
  "get_day_transcript",
  "get_stats",
  "list_events",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const toolSchemas: Record<ToolName, z.ZodType> = {
  find_first: findSchema,
  find_last: findSchema,
  count_matches: match,
  matches_per_period: periodSchema,
  keyword_search: keywordSchema,
  semantic_search: semanticSchema,
  hybrid_search: keywordSchema,
  get_context_around: contextSchema,
  get_day_transcript: daySchema,
  get_stats: statsSchema,
  list_events: eventsSchema,
};

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}
