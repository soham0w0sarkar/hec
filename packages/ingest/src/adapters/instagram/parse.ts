import type { MessageExtras } from "@hec/core";
import { repairInstagramText } from "../../encoding";
import { IngestError } from "../../errors";
import type { ParsedMessage } from "../../types";

type IgReaction = { reaction?: unknown; actor?: unknown };
type IgShare = { link?: unknown; share_text?: unknown; original_content_owner?: unknown };
type IgMessage = {
  sender_name?: unknown;
  timestamp_ms?: unknown;
  content?: unknown;
  reactions?: unknown;
  share?: unknown;
  photos?: unknown;
  videos?: unknown;
  audio_files?: unknown;
  gifs?: unknown;
  sticker?: unknown;
  call_duration?: unknown;
  is_unsent?: unknown;
};

export type InstagramParseResult = {
  messages: ParsedMessage[];
  repairedFields: number;
};

export function parseInstagramExport(fileName: string, contents: string): InstagramParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new IngestError(`${fileName}: ${message}`);
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.messages)) {
    throw new IngestError(`${fileName}: expected a messages array`);
  }

  let repairedFields = 0;
  const messages = parsed.messages.map((raw, index) => {
    if (!isRecord(raw)) throw new IngestError(`${fileName}: message ${index} is not an object`);
    const built = toMessage(fileName, index, raw as IgMessage, () => {
      repairedFields += 1;
    });
    return built;
  });

  return { messages, repairedFields };
}

function toMessage(fileName: string, index: number, raw: IgMessage, onRepair: () => void): ParsedMessage {
  if (typeof raw.sender_name !== "string") throw new IngestError(`${fileName}: message ${index} has no sender`);
  if (typeof raw.timestamp_ms !== "number" || !Number.isFinite(raw.timestamp_ms)) {
    throw new IngestError(`${fileName}: message ${index} has no timestamp`);
  }

  const senderRaw = repair(raw.sender_name, onRepair);
  const content = typeof raw.content === "string" ? repair(raw.content, onRepair) : "";
  const share = isRecord(raw.share) ? (raw.share as IgShare) : undefined;
  const shareText = typeof share?.share_text === "string" ? repair(share.share_text, onRepair) : "";
  const extras: MessageExtras = {};
  const reactions = reactionsOf(raw.reactions, onRepair);
  if (reactions.length > 0) extras.reactions = reactions;

  const sentAt = new Date(raw.timestamp_ms);
  const sourceRef = `${fileName}:${index}`;

  if (raw.is_unsent === true) {
    return message(senderRaw, sentAt, content, sourceRef, "unsent", extras);
  }

  if (typeof raw.call_duration === "number") {
    extras.call = {
      durationSeconds: raw.call_duration,
      missed: /missed/i.test(content),
      medium: /video/i.test(content) ? "video" : "voice",
    };
    return message(senderRaw, sentAt, content, sourceRef, "call", extras);
  }

  if (share) {
    extras.share = {
      link: typeof share.link === "string" ? share.link : undefined,
      text: shareText || undefined,
      owner: typeof share.original_content_owner === "string" ? repair(share.original_content_owner, onRepair) : undefined,
    };
    const text = isAttachmentBoilerplate(content) ? shareText || content : content || shareText;
    return message(senderRaw, sentAt, text, sourceRef, "share", extras);
  }

  const media = mediaOf(raw);
  if (media) {
    extras.media = media;
    return message(senderRaw, sentAt, content || media.label, sourceRef, "media", extras);
  }

  if (!content) return message(senderRaw, sentAt, "", sourceRef, "unsent", extras);
  return message(senderRaw, sentAt, content, sourceRef, "text", extras);
}

function message(
  senderRaw: string,
  sentAt: Date,
  text: string,
  sourceRef: string,
  kind: ParsedMessage["kind"],
  extras: MessageExtras,
): ParsedMessage {
  return { senderRaw, sentAt, text, source: "instagram", sourceRef, kind, extras };
}

function reactionsOf(value: unknown, onRepair: () => void): { emoji: string; actor: string }[] {
  if (!Array.isArray(value)) return [];
  const reactions = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const reaction = raw as IgReaction;
    if (typeof reaction.reaction !== "string" || typeof reaction.actor !== "string") continue;
    reactions.push({ emoji: repair(reaction.reaction, onRepair), actor: repair(reaction.actor, onRepair) });
  }
  return reactions;
}

function mediaOf(raw: IgMessage): { types: string[]; label: string } | undefined {
  const types: string[] = [];
  if (Array.isArray(raw.photos) && raw.photos.length > 0) types.push("photo");
  if (Array.isArray(raw.videos) && raw.videos.length > 0) types.push("video");
  if (Array.isArray(raw.audio_files) && raw.audio_files.length > 0) types.push("audio");
  if (Array.isArray(raw.gifs) && raw.gifs.length > 0) types.push("gif");
  if (isRecord(raw.sticker)) types.push("sticker");
  if (types.length === 0) return undefined;
  return { types, label: types.join("+") };
}

function isAttachmentBoilerplate(content: string): boolean {
  return content.length === 0 || /sent an attachment\.?$/i.test(content);
}

function repair(value: string, onRepair: () => void): string {
  const repaired = repairInstagramText(value);
  if (repaired !== value) onRepair();
  return repaired;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
