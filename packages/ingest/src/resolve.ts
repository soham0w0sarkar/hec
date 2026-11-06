import type { PersonId } from "@hec/core";
import { IngestError } from "./errors";
import type { ParsedMessage } from "./types";

export type ResolvedMessage = ParsedMessage & { personId: PersonId };

export function resolveSenders(messages: ParsedMessage[], names: Record<string, PersonId>, fileName: string): ResolvedMessage[] {
  const unknown = new Set<string>();
  for (const message of messages) {
    if (!names[message.senderRaw]) unknown.add(message.senderRaw || "(no sender)");
  }
  if (unknown.size > 0) {
    throw new IngestError(`${fileName}: unknown sender names: ${[...unknown].join(", ")}`);
  }

  return messages.map((message) => {
    const personId = names[message.senderRaw];
    if (!personId) throw new IngestError(`${fileName}: unknown sender ${message.senderRaw}`);
    return { ...message, personId };
  });
}
