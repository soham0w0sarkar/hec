import { describe, expect, test } from "bun:test";
import { SESSION_GAP_MS, buildSessions, type SessionMessage } from "./group";

function message(id: number, hour: number, source: SessionMessage["source"] = "instagram", kind: SessionMessage["kind"] = "text"): SessionMessage {
  return {
    id,
    sentAt: new Date(Date.UTC(2026, 0, 1, hour)),
    source,
    kind,
  };
}

describe("buildSessions", () => {
  test("starts a new session after more than four hours of silence", () => {
    const sessions = buildSessions([
      message(1, 0),
      message(2, 4),
      message(3, 4 + SESSION_GAP_MS / (60 * 60 * 1000) + 1),
    ]);

    expect(sessions.map((session) => session.messageIds)).toEqual([[1, 2], [3]]);
  });

  test("keeps a conversation that switches apps", () => {
    const sessions = buildSessions([
      message(1, 1, "instagram"),
      message(2, 2, "whatsapp"),
    ]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sources).toEqual(["instagram", "whatsapp"]);
    expect(sessions[0]?.messageIds).toEqual([1, 2]);
  });

  test("ignores system lines when measuring silence", () => {
    const early = message(1, 0);
    const notice = message(2, 2, "instagram", "system");
    const later = { ...message(3, 0), sentAt: new Date(early.sentAt.getTime() + SESSION_GAP_MS + 60_000) };
    const sessions = buildSessions([later, notice, early]);

    expect(sessions.map((session) => session.messageIds)).toEqual([[1], [3]]);
  });
});
