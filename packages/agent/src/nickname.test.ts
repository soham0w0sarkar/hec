import { describe, expect, test } from "bun:test";
import { isNicknameQuestion } from "./nickname";

describe("isNicknameQuestion", () => {
  test("matches pet-name and address questions", () => {
    expect(isNicknameQuestion("What nicknames do they use?")).toBe(true);
    expect(isNicknameQuestion("What names do I use for Tanvi instead of Tanvi?")).toBe(true);
    expect(isNicknameQuestion("Jo names main Tanvi ko bolta hu uske naam ki jagah")).toBe(true);
    expect(isNicknameQuestion("what does she call me")).toBe(true);
    expect(isNicknameQuestion("pet names")).toBe(true);
  });

  test("ignores unrelated questions", () => {
    expect(isNicknameQuestion("Who said I love you first?")).toBe(false);
    expect(isNicknameQuestion("How many messages on Tuesday?")).toBe(false);
  });
});
