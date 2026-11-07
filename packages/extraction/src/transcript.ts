import { DISPLAY_TIMEZONE, type MessageSource } from "@hec/core";
import { formatLocal } from "./time";
import { type ExtractionMessage, type SpeakerLabels } from "./types";

/** Kinds left out of extraction. Matches the README: system lines never reach the model. */
const SKIPPED_KINDS: readonly string[] = ["system", "unsent"];

const SOURCE_TAG: Record<MessageSource, string> = { instagram: "ig", whatsapp: "wa" };

export type WindowOptions = {
  /** Character budget for one window's transcript. About a quarter of this in tokens. */
  maxChars?: number;
  maxMessages?: number;
  /** Messages repeated at the start of the next window, so an event on the seam is seen whole. */
  overlap?: number;
  /** Longer messages are cut in the transcript. A quote can only come from what the model saw. */
  maxLineChars?: number;
  timeZone?: string;
  /** Names as they should appear in the transcript. Required: the model must see the real names. */
  labels: SpeakerLabels;
};

export const DEFAULT_WINDOW_OPTIONS = {
  maxChars: 30_000,
  maxMessages: 600,
  overlap: 15,
  maxLineChars: 1_500,
} as const;

export type TranscriptWindow = {
  /** Zero based, in time order. */
  index: number;
  total: number;
  messages: ExtractionMessage[];
  /** The text sent to the model, one line per message. */
  transcript: string;
};

export function refOf(messageId: number): string {
  return `m${messageId}`;
}

/** Accepts `m123`, `[m123]` and surrounding spaces. Returns null for anything else. */
export function parseRef(ref: unknown): number | null {
  if (typeof ref !== "string") return null;
  const match = /^\[?\s*m(\d+)\s*\]?$/.exec(ref.trim());
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

/** Newlines and runs of spaces become one space. Quotes are compared in this form. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Messages that can carry evidence, in time order. */
export function usableMessages(messages: readonly ExtractionMessage[]): ExtractionMessage[] {
  return messages
    .filter((message) => !SKIPPED_KINDS.includes(message.kind))
    .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime() || a.id - b.id);
}

/** `[m123] 2026-03-04 21:07 Name ig: text`. Media, calls and shares are marked in angle brackets. */
export function formatLine(message: ExtractionMessage, options: WindowOptions): string {
  const labels = options.labels;
  const maxLine = options.maxLineChars ?? DEFAULT_WINDOW_OPTIONS.maxLineChars;
  const when = formatLocal(message.sentAt, options.timeZone ?? DISPLAY_TIMEZONE);

  let body = collapseWhitespace(message.text);
  if (body.length > maxLine) body = `${body.slice(0, maxLine)}…`;
  if (message.kind !== "text") body = body === "" ? `<${message.kind}>` : `<${message.kind}> ${body}`;

  return `[${refOf(message.id)}] ${when} ${labels[message.personId]} ${SOURCE_TAG[message.source]}: ${body}`;
}

/**
 * Splits one session into transcript windows. A short session is one window. A long one is cut at
 * message boundaries into windows that overlap by `overlap` messages.
 */
export function buildWindows(messages: readonly ExtractionMessage[], options: WindowOptions): TranscriptWindow[] {
  const maxChars = options.maxChars ?? DEFAULT_WINDOW_OPTIONS.maxChars;
  const maxMessages = options.maxMessages ?? DEFAULT_WINDOW_OPTIONS.maxMessages;
  const overlap = Math.max(0, options.overlap ?? DEFAULT_WINDOW_OPTIONS.overlap);

  const usable = usableMessages(messages);
  const lines = usable.map((message) => formatLine(message, options));
  if (usable.length === 0) return [];

  const ranges: [number, number][] = [];
  let start = 0;
  while (start < usable.length) {
    let end = start;
    let chars = 0;
    // Always take at least one message, so an oversized line still makes progress.
    while (end < usable.length && end - start < maxMessages) {
      const next = (lines[end] as string).length + 1;
      if (end > start && chars + next > maxChars) break;
      chars += next;
      end++;
    }
    ranges.push([start, end]);
    if (end >= usable.length) break;
    // Step back by the overlap, but never so far that the window does not advance.
    start = Math.max(end - overlap, start + 1);
  }

  return ranges.map(([from, to], index) => ({
    index,
    total: ranges.length,
    messages: usable.slice(from, to),
    transcript: lines.slice(from, to).join("\n"),
  }));
}

/**
 * Cuts one window into two halves that keep its index. The halves overlap by a few messages so an
 * event on the seam is seen whole. Null when the window has one message and cannot be cut.
 */
export function splitWindow(window: TranscriptWindow, options: WindowOptions): [TranscriptWindow, TranscriptWindow] | null {
  const count = window.messages.length;
  if (count < 2) return null;
  // Capped at a quarter of the window so every half is strictly shorter than the window.
  const overlap = Math.min(Math.max(0, options.overlap ?? DEFAULT_WINDOW_OPTIONS.overlap), Math.floor(count / 4));
  const mid = Math.floor(count / 2);
  const half = (from: number, to: number): TranscriptWindow => {
    const messages = window.messages.slice(from, to);
    return {
      index: window.index,
      total: window.total,
      messages,
      transcript: messages.map((message) => formatLine(message, options)).join("\n"),
    };
  };
  return [half(0, mid + overlap), half(mid, count)];
}
