import { describe, expect, test } from "bun:test";
import { applySpokenKinds, isSaidFirstQuestion, phraseIsSpoken } from "./spoken";

describe("isSaidFirstQuestion", () => {
  test("matches who-said-first style questions", () => {
    expect(isSaidFirstQuestion("Who said I love you first?")).toBe(true);
    expect(isSaidFirstQuestion("When did we first say good night?")).toBe(true);
    expect(isSaidFirstQuestion("kisne pehle I love you bola")).toBe(true);
  });

  test("ignores unrelated questions", () => {
    expect(isSaidFirstQuestion("What nicknames do we use?")).toBe(false);
    expect(isSaidFirstQuestion("How many messages yesterday?")).toBe(false);
  });
});

describe("applySpokenKinds", () => {
  test("defaults said-first searches to typed text", () => {
    expect(applySpokenKinds("Who said I love you first?", { text: "I love you", mode: "phrase" })).toEqual({
      text: "I love you",
      mode: "phrase",
      kinds: ["text"],
    });
  });

  test("strips share from an explicit kinds list", () => {
    expect(
      applySpokenKinds("Who said I love you first?", {
        text: "I love you",
        mode: "phrase",
        kinds: ["text", "share"],
      }),
    ).toEqual({
      text: "I love you",
      mode: "phrase",
      kinds: ["text"],
    });
  });

  test("leaves non-said-first questions alone", () => {
    expect(applySpokenKinds("show me shared reels about love", { text: "love", mode: "phrase" })).toEqual({
      text: "love",
      mode: "phrase",
    });
  });
});

describe("phraseIsSpoken", () => {
  test("accepts real address lines and rejects who-love-you jokes", () => {
    expect(phraseIsSpoken("Love you, bye", "love you")).toBe(true);
    expect(phraseIsSpoken("I love you", "I love you")).toBe(true);
    expect(phraseIsSpoken("Loveeee youuuuuu my baby seal", "love you")).toBe(true);
    expect(phraseIsSpoken("(I loveeee youuu toooo😘)", "I love you")).toBe(true);
    expect(phraseIsSpoken("I can fight 1000 LLM's who love you", "love you")).toBe(false);
    expect(phraseIsSpoken("I can fight 1000 LLM's who love you", "I love you")).toBe(false);
  });

  test("rejects a phrase wrapped in a joke", () => {
    expect(phraseIsSpoken("(it all majak, I love you, sorry)", "I love you")).toBe(false);
    expect(phraseIsSpoken("I love you, just kidding", "I love you")).toBe(false);
  });
});
