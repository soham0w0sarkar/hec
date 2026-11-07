import { z } from "zod";

/**
 * Neutral answer the agent hands to a persona. Version 1.
 * Wording and jokes belong in the persona, never in these fields.
 * A quote may contain emoji because it is copied from a message. Every other string may not.
 */
export const ANSWER_PAYLOAD_VERSION = 1 as const;

export const QUESTION_TYPES = [
  "first_last",
  "count",
  "what_did_we_say",
  "on_this_date",
  "stats",
  "timeline",
  "other",
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const VERDICTS = ["found", "not_found", "ambiguous", "partial"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const CONFIDENCE_LEVELS = ["high", "medium", "low", "ambiguous"] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const SENSITIVITY_LEVELS = ["none", "heavy"] as const;
export type Sensitivity = (typeof SENSITIVITY_LEVELS)[number];

/**
 * What a claim is allowed to rest on.
 * `messages` needs message ids. `count`, `stats`, and `timeline` may cite no message
 * when the number or the event came from that tool and the text contains only those figures.
 */
export const CLAIM_BASES = ["messages", "count", "stats", "timeline"] as const;
export type ClaimBasis = (typeof CLAIM_BASES)[number];

const EMOJI = /\p{Extended_Pictographic}/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const plain = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !EMOJI.test(value), { message: "no emoji outside a quote" });

export const AnswerClaimSchema = z
  .object({
    text: plain(500),
    message_ids: z.array(z.number().int().positive()).max(20),
    /** `YYYY-MM-DD` in the display timezone. Null when the claim is a total, not a day. */
    date: z.string().regex(DAY).nullable(),
    /** Display name from the tool result. Null for a total. */
    person: plain(80).nullable(),
    source: z.enum(["instagram", "whatsapp"]).nullable(),
    /** Exact substring of a retrieved message, or null. */
    quote: z.string().min(1).max(500).nullable(),
    basis: z.enum(CLAIM_BASES),
  })
  .strict();
export type AnswerClaim = z.infer<typeof AnswerClaimSchema>;

export const AnswerPayloadSchema = z
  .object({
    version: z.literal(ANSWER_PAYLOAD_VERSION),
    question_type: z.enum(QUESTION_TYPES),
    verdict: z.enum(VERDICTS),
    interpretation_note: plain(500),
    claims: z.array(AnswerClaimSchema).max(12),
    searched: z
      .object({
        tools: z.array(z.string().min(1).max(40)).max(40),
        variants: z.array(z.string().min(1).max(80)).max(32),
        date_ranges: z
          .array(
            z
              .object({
                from: z.string().min(1).max(40).nullable(),
                until: z.string().min(1).max(40).nullable(),
              })
              .strict(),
          )
          .max(20),
      })
      .strict(),
    caveats: z.array(plain(400)).max(12),
    confidence: z.enum(CONFIDENCE_LEVELS),
    sensitivity: z.enum(SENSITIVITY_LEVELS),
  })
  .strict();
export type AnswerPayload = z.infer<typeof AnswerPayloadSchema>;
