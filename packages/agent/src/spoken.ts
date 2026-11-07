import type { MessageKind } from "@hec/core";

const SAID_FIRST =
  /\b(who\s+said|said\s+.+\s+first|first\s+(one\s+to\s+)?say|first\s+time\b.+\b(said|say|boli|bola)|who\s+(typed|wrote|sent).+\bfirst|pehle\s+kis(?:ne)?\s+bola|kisne\s+pehle|kab\s+pehle\s+bola)\b/i;

/** "Who said X first" and similar — answer from typed chat, not reels/shares. */
export function isSaidFirstQuestion(question: string): boolean {
  return SAID_FIRST.test(question);
}

/**
 * For said-first questions, drop Instagram shares/reels unless the user asked about them.
 * Default to typed text when kinds were omitted.
 */
export function applySpokenKinds(question: string, input: Record<string, unknown>): Record<string, unknown> {
  if (!isSaidFirstQuestion(question)) return input;
  if (/\b(reel|reels|share|shares|caption)\b/i.test(question)) return input;

  const kinds = input.kinds;
  if (!Array.isArray(kinds) || kinds.length === 0) {
    return { ...input, kinds: ["text"] satisfies MessageKind[] };
  }
  const kept = kinds.filter((kind): kind is MessageKind => kind !== "share");
  return { ...input, kinds: kept.length > 0 ? kept : (["text"] satisfies MessageKind[]) };
}

/**
 * True when the needle looks like something someone said, not a random substring
 * ("who love you" inside a joke does not count as saying "love you").
 */
export function phraseIsSpoken(haystack: string, needle: string): boolean {
  // Squash elongated spellings so "Loveeee youuuu" still counts as "love you".
  const h = squash(haystack);
  const n = squash(needle);
  if (!n || n.length < 2 || !h.includes(n)) return false;

  let from = 0;
  while (from <= h.length) {
    const index = h.indexOf(n, from);
    if (index < 0) return false;
    const before = index === 0 ? " " : h[index - 1]!;
    const afterIdx = index + n.length;
    const after = afterIdx >= h.length ? " " : h[afterIdx]!;
    const boundaryBefore = index === 0 || /[\s([{'"“‘,]/.test(before);
    const boundaryAfter = afterIdx >= h.length || /[\s)\]}'"”’,.!?;:…]/.test(after);
    if (boundaryBefore && boundaryAfter) {
      const prefix = h.slice(Math.max(0, index - 6), index);
      // "who/they/to love you" is not addressing the other person with that phrase.
      if (/^(love you|love u|luv you|luv u)$/i.test(n) && /\b(who|they|to|that|people)\s+$/i.test(prefix)) {
        from = index + 1;
        continue;
      }
      return true;
    }
    from = index + 1;
  }
  return false;
}

function squash(value: string): string {
  return value
    .toLowerCase()
    .replace(/(.)\1+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Any of the search phrases appears as a spoken phrase in the message text. */
export function messageSaysPhrase(text: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => phraseIsSpoken(text, phrase));
}
