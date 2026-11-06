import type { MessageExtras, MessageKind, MessageSource } from "@hec/core";

/** One export message, before the raw sender name is resolved to a person. */
export type ParsedMessage = {
  senderRaw: string;
  sentAt: Date;
  text: string;
  source: MessageSource;
  sourceRef: string;
  kind: MessageKind;
  extras: MessageExtras;
};
