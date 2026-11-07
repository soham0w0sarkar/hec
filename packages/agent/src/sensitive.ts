/** Intimate wording. A general question must not receive these lines. The marker is for fixtures. */
const INTIMATE =
  /\b(nude|nudes|horny|orgasm|blowjob|handjob|dick|cock|pussy|boobs|moan|sext|sex)\b|SYNTHETIC_INTIMATE/i;

/** The question itself asked to see that material. */
const INTIMATE_ASK = /\b(intimate|explicit|sext|nude|nudes|sexual|sex)\b|in bed|SYNTHETIC_INTIMATE/i;

/**
 * Fights, breakups, illness, grief. "ill" alone is not here: it matches too much ordinary English.
 * Unsure cases are treated as heavy by the caller, not by this list.
 */
const HEAVY =
  /\b(fight|fought|fighting|breakup|break-up|broke up|broken up|sad|sadness|illness|grief|died|death|cry|crying|cried|hurt|painful|depressed|depression|anxious|anxiety|argument|conflict)\b/i;

export function isIntimateText(text: string): boolean {
  return INTIMATE.test(text);
}

export function questionWantsIntimate(question: string): boolean {
  return INTIMATE_ASK.test(question);
}

export function questionIsHeavy(question: string): boolean {
  return HEAVY.test(question);
}
