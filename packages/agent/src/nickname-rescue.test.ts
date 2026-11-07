import { describe, expect, test } from "bun:test";
import { createLedger, rememberMessage } from "./ledger";
import { rescueNicknameAnswer } from "./nickname-rescue";

describe("rescueNicknameAnswer", () => {
  test("builds found claims from addressing pet-name messages in the ledger", () => {
    const ledger = createLedger();
    rememberMessage(ledger, {
      id: 1,
      personId: "person_1",
      name: "Soham",
      source: "instagram",
      sentAt: "2026-02-20T04:00:00.000Z",
      sentAtIst: "2026-02-20 09:30:00",
      text: "Good Morning, my baby seal",
      kind: "text",
      intimate: false,
    });
    rememberMessage(ledger, {
      id: 2,
      personId: "person_2",
      name: "Tanvi",
      source: "instagram",
      sentAt: "2026-05-02T18:00:00.000Z",
      sentAtIst: "2026-05-02 23:30:00",
      text: "meow meow",
      kind: "text",
      intimate: false,
    });
    const people = [
      { id: "person_1", name: "Soham" },
      { id: "person_2", name: "Tanvi" },
    ];
    const payload = rescueNicknameAnswer(ledger, people);
    expect(payload?.verdict).toBe("found");
    expect(payload?.claims.length).toBe(2);
    expect(payload?.claims.some((claim) => claim.quote?.includes("baby seal"))).toBe(true);
    expect(payload?.claims.some((claim) => /meow meow/i.test(claim.quote ?? ""))).toBe(true);
  });

  test("returns null when the ledger has no pet-name lines", () => {
    const ledger = createLedger();
    rememberMessage(ledger, {
      id: 3,
      personId: "person_1",
      name: "Soham",
      source: "instagram",
      sentAt: "2026-02-20T04:00:00.000Z",
      sentAtIst: "2026-02-20 09:30:00",
      text: "hello there",
      kind: "text",
      intimate: false,
    });
    expect(rescueNicknameAnswer(ledger, [])).toBeNull();
  });
});
