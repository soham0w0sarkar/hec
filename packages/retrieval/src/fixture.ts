import type { SQL } from "bun";
import { EMBEDDING_DIMENSIONS, type MessageKind, type MessageSource, type PersonId } from "@hec/core";

export const FIXTURE_MODEL = "text-embedding-3-small";
export const FIXTURE_OTHER_MODEL = "other-model";

type FixtureMessage = {
  personId: PersonId;
  /** UTC instant. Comments show the India Standard Time wall clock. */
  sentAt: string;
  text: string;
  source: MessageSource;
  sourceRef: string;
  kind: MessageKind;
};

/** Invented 2030 chats. Not from anyone's export. */
export const FIXTURE_MESSAGES: readonly FixtureMessage[] = [
  { personId: "person_1", sentAt: "2030-06-01T04:30:00.000Z", text: "loveee youuu", source: "instagram", sourceRef: "ig:loveee", kind: "text" },
  { personId: "person_2", sentAt: "2030-06-01T04:35:00.000Z", text: "i love you too", source: "instagram", sourceRef: "ig:love", kind: "text" },
  { personId: "person_1", sentAt: "2030-06-01T04:36:00.000Z", text: "lovee youu", source: "instagram", sourceRef: "ig:lovee", kind: "text" },
  { personId: "person_2", sentAt: "2030-06-01T18:20:00.000Z", text: "kal milte hain yaar", source: "whatsapp", sourceRef: "wa:milte", kind: "text" },
  { personId: "person_1", sentAt: "2030-06-01T18:40:00.000Z", text: "good morning 😂", source: "instagram", sourceRef: "ig:morning", kind: "text" },
  { personId: "person_1", sentAt: "2030-06-02T06:30:00.000Z", text: "same instant", source: "instagram", sourceRef: "tie-b", kind: "text" },
  { personId: "person_2", sentAt: "2030-06-02T06:30:00.000Z", text: "same instant", source: "instagram", sourceRef: "tie-a", kind: "text" },
  { personId: "person_1", sentAt: "2030-06-02T06:30:00.000Z", text: "same instant", source: "whatsapp", sourceRef: "tie-a", kind: "text" },
  { personId: "person_2", sentAt: "2030-06-02T07:30:00.000Z", text: "luv u", source: "whatsapp", sourceRef: "wa:luv", kind: "text" },
  { personId: "person_1", sentAt: "2030-06-02T08:30:00.000Z", text: "lo\u200Bve", source: "instagram", sourceRef: "ig:zw", kind: "text" },
  { personId: "person_1", sentAt: "2030-06-03T03:30:00.000Z", text: "goood night", source: "instagram", sourceRef: "ig:good", kind: "text" },
  { personId: "person_2", sentAt: "2030-06-03T04:00:00.000Z", text: "heart \u2764", source: "instagram", sourceRef: "ig:heart", kind: "text" },
  { personId: "person_1", sentAt: "2030-06-04T05:30:00.000Z", text: "audio call", source: "instagram", sourceRef: "ig:call", kind: "call" },
  { personId: "person_2", sentAt: "2030-06-04T06:30:00.000Z", text: "system line about the chat", source: "whatsapp", sourceRef: "wa:system", kind: "system" },
  { personId: "person_1", sentAt: "2030-06-04T06:31:00.000Z", text: "", source: "instagram", sourceRef: "ig:empty", kind: "text" },
  { personId: "person_2", sentAt: "2030-06-04T06:32:00.000Z", text: "forgot", source: "instagram", sourceRef: "ig:unsent", kind: "unsent" },
  { personId: "person_1", sentAt: "2030-06-05T02:30:00.000Z", text: "cafe\u0301", source: "instagram", sourceRef: "ig:nfc", kind: "text" },
  { personId: "person_2", sentAt: "2030-06-05T02:31:00.000Z", text: "bad\uFFFD", source: "instagram", sourceRef: "ig:fffd", kind: "text" },
  { personId: "person_1", sentAt: "2030-06-05T02:32:00.000Z", text: "caf\u00c3\u00a9", source: "whatsapp", sourceRef: "wa:mojibake", kind: "text" },
];

export function basisVector(index: number): number[] {
  const values = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
  values[index] = 1;
  return values;
}

/** Inserts the fixture. The caller truncates or rolls back. */
export async function seedFixture(sql: SQL): Promise<void> {
  await sql`update people set name = 'Ravi' where id = 'person_1'`;
  await sql`update people set name = 'Anita' where id = 'person_2'`;

  const first = FIXTURE_MESSAGES[0]!;
  const last = FIXTURE_MESSAGES.at(-1)!;
  const sessions = (await sql`
    insert into sessions (started_at, ended_at, message_count, sources)
    values (
      ${first.sentAt}::timestamptz,
      ${last.sentAt}::timestamptz,
      ${FIXTURE_MESSAGES.length},
      array['instagram','whatsapp']::message_source[]
    )
    returning id
  `) as { id: string | number }[];
  const sessionId = sessions[0]?.id;
  if (sessionId === undefined) throw new Error("fixture session was not created");

  for (const message of FIXTURE_MESSAGES) {
    await sql`
      insert into messages (person_id, sent_at, "text", source, source_ref, kind, session_id)
      values (
        ${message.personId},
        ${message.sentAt}::timestamptz,
        ${message.text},
        ${message.source}::message_source,
        ${message.sourceRef},
        ${message.kind}::message_kind,
        ${sessionId}
      )
    `;
  }

  const ids = (await sql`select source_ref, id from messages`) as { source_ref: string; id: string | number }[];
  const idOf = (ref: string) => {
    const row = ids.find((item) => item.source_ref === ref);
    if (!row) throw new Error(`fixture message ${ref} is missing`);
    return row.id;
  };

  const chunks = [
    { position: 0, first: "ig:loveee", last: "ig:lovee", count: 3, model: FIXTURE_MODEL, vector: basisVector(0), transcript: "Ravi and Anita, morning of 1 June 2030" },
    { position: 1, first: "wa:milte", last: "wa:milte", count: 1, model: FIXTURE_MODEL, vector: basisVector(1), transcript: "Anita on WhatsApp, late 1 June 2030" },
    { position: 2, first: "ig:loveee", last: "ig:lovee", count: 3, model: FIXTURE_OTHER_MODEL, vector: basisVector(0), transcript: "same morning, other model" },
  ];
  for (const chunk of chunks) {
    await sql`
      insert into chunks (
        session_id, position, first_message_id, last_message_id, message_count, transcript, embedding, embedding_model
      ) values (
        ${sessionId},
        ${chunk.position},
        ${idOf(chunk.first)},
        ${idOf(chunk.last)},
        ${chunk.count},
        ${chunk.transcript},
        ${`[${chunk.vector.join(",")}]`}::vector,
        ${chunk.model}
      )
    `;
  }
  await sql`select refresh_daily_stats()`;
}
