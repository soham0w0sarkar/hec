import type { MessageExtras } from "@hec/core";
import { IngestError } from "../../errors";
import type { ParsedMessage } from "../../types";
import { zonedLocalToUtc } from "../../time";

export type DateOrder = "DMY" | "MDY";
export type HourClock = "12" | "24" | "auto";

export type WhatsAppParseOptions = {
  timeZone: string;
  dateOrder?: DateOrder;
  hourClock?: HourClock;
};

const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const BRACKET_HEADER =
  /^\[(\d{1,4})[./](\d{1,2})[./](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AaPp][Mm]))?\]\s+([\s\S]*)$/;
const DASH_HEADER =
  /^(\d{1,4})[./](\d{1,2})[./](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AaPp][Mm]))?\s+-\s+([\s\S]*)$/;
const EDITED = /\s*<This message was edited>\s*$/i;
const MEDIA =
  /^(.*?)(?:<media omitted>|(image|video|audio|sticker|gif|document|contact card) omitted)\s*$/i;

type Header = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ampm?: string;
  rest: string;
  startLine: number;
  yearFirst: boolean;
  pendingA?: number;
  pendingB?: number;
};

type Draft = Header & { endLine: number; lines: string[] };

export function parseWhatsAppExport(fileName: string, contents: string, options: WhatsAppParseOptions): ParsedMessage[] {
  const lines = contents.replace(BIDI, "").replace(/\u202f/g, " ").replace(/\u00a0/g, " ").split(/\r?\n/);
  const drafts: Draft[] = [];
  const orphans: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    const header = readHeader(line, i + 1);
    if (!header) {
      const current = drafts.at(-1);
      if (!current) orphans.push(i + 1);
      else {
        current.lines.push(line);
        current.endLine = i + 1;
      }
      continue;
    }
    drafts.push({ ...header, endLine: i + 1, lines: [header.rest] });
  }

  if (orphans.length > 0) {
    throw new IngestError(`${fileName}: ${orphans.length} lines before the first message (first at line ${orphans[0]})`);
  }
  if (drafts.length === 0) return [];

  const order = resolveDateOrder(drafts, options.dateOrder, fileName);
  const clock = resolveHourClock(drafts, options.hourClock ?? "auto", fileName);

  return drafts.map((draft) => {
    const sentAt = zonedLocalToUtc(
      {
        year: draft.year,
        month: draft.month,
        day: draft.day,
        hour: to24Hour(draft.hour, draft.ampm, clock, fileName, draft.startLine),
        minute: draft.minute,
        second: draft.second,
      },
      options.timeZone,
    );
    const { senderRaw, body } = splitSender(draft.lines.join("\n"));
    const edited = EDITED.test(body);
    const cleaned = body.replace(EDITED, "").replace(/\n+$/g, "");
    const classified = classify(cleaned, senderRaw);
    const extras: MessageExtras = { ...classified.extras };
    if (edited) extras.edited = true;

    return {
      senderRaw,
      sentAt,
      text: classified.text,
      source: "whatsapp",
      sourceRef: `${fileName}:${draft.startLine}-${draft.endLine}`,
      kind: classified.kind,
      extras,
    };
  });
}

function readHeader(line: string, startLine: number): Header | undefined {
  const match = BRACKET_HEADER.exec(line) ?? DASH_HEADER.exec(line);
  if (!match) return undefined;

  const first = Number(match[1]);
  const second = Number(match[2]);
  const third = Number(match[3]);
  const yearFirst = first >= 1000;
  const rawYear = yearFirst ? first : third;
  const year = rawYear < 100 ? rawYear + (rawYear >= 70 ? 1900 : 2000) : rawYear;
  const month = yearFirst ? second : 0;
  const day = yearFirst ? Number(match[3]) : 0;

  return {
    year,
    month,
    day,
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: match[6] ? Number(match[6]) : 0,
    ampm: match[7]?.toUpperCase(),
    rest: match[8] ?? "",
    startLine,
    yearFirst,
    pendingA: yearFirst ? undefined : first,
    pendingB: yearFirst ? undefined : second,
  };
}

function resolveDateOrder(drafts: Draft[], hint: DateOrder | undefined, fileName: string): DateOrder {
  let dayFirst = false;
  let monthFirst = false;
  for (const draft of drafts) {
    if (draft.yearFirst || draft.pendingA === undefined || draft.pendingB === undefined) continue;
    if (draft.pendingA > 12) dayFirst = true;
    if (draft.pendingB > 12) monthFirst = true;
  }

  if (dayFirst && monthFirst) throw new IngestError(`${fileName}: dates contradict each other`);
  const detected = dayFirst ? "DMY" : monthFirst ? "MDY" : undefined;
  if (detected && hint && detected !== hint) {
    throw new IngestError(`${fileName}: dates are ${detected} but config says ${hint}`);
  }
  const order = detected ?? hint;
  if (!order) throw new IngestError(`${fileName}: date order is ambiguous. Set whatsapp.dateOrder to DMY or MDY.`);

  for (const draft of drafts) {
    if (draft.yearFirst || draft.pendingA === undefined || draft.pendingB === undefined) continue;
    draft.day = order === "DMY" ? draft.pendingA : draft.pendingB;
    draft.month = order === "DMY" ? draft.pendingB : draft.pendingA;
  }
  return order;
}

function resolveHourClock(drafts: Draft[], hint: HourClock, fileName: string): "12" | "24" {
  const hasMeridiem = drafts.some((draft) => draft.ampm);
  const hasTwentyFour = drafts.some((draft) => !draft.ampm && draft.hour > 12);
  if (hasMeridiem && hasTwentyFour) throw new IngestError(`${fileName}: mixes 12-hour and 24-hour times`);
  if (hint === "12" || hint === "24") return hint;
  return hasMeridiem ? "12" : "24";
}

function to24Hour(hour: number, ampm: string | undefined, clock: "12" | "24", fileName: string, line: number): number {
  if (ampm) {
    if (hour < 1 || hour > 12) throw new IngestError(`${fileName}:${line}: hour ${hour} ${ampm} is invalid`);
    if (hour === 12) return ampm === "AM" ? 0 : 12;
    return ampm === "PM" ? hour + 12 : hour;
  }
  if (clock === "12") throw new IngestError(`${fileName}:${line}: 12-hour clock but the line has no AM/PM`);
  if (hour > 23) throw new IngestError(`${fileName}:${line}: hour ${hour} is invalid`);
  return hour;
}

function splitSender(rest: string): { senderRaw: string; body: string } {
  const match = /^(.{1,80}?):\s?([\s\S]*)$/.exec(rest);
  const senderRaw = match?.[1]?.trim() ?? "";
  if (!match || !senderRaw) return { senderRaw: "", body: rest.trim() };
  return { senderRaw, body: match[2] ?? "" };
}

function classify(body: string, senderRaw: string): { kind: ParsedMessage["kind"]; text: string; extras: MessageExtras } {
  const trimmed = body.trim();
  if (/^(?:you deleted this message|this message was deleted)$/i.test(trimmed)) {
    return { kind: "unsent", text: trimmed, extras: {} };
  }

  const call = /^(missed\s+)?(?:group\s+)?(voice|video)\s+call\b([\s\S]*)$/i.exec(trimmed);
  if (call) {
    return {
      kind: "call",
      text: trimmed,
      extras: {
        call: {
          missed: Boolean(call[1]),
          medium: call[2]?.toLowerCase() === "video" ? "video" : "voice",
          durationSeconds: durationSeconds(call[3] ?? ""),
        },
      },
    };
  }

  const media = MEDIA.exec(trimmed);
  if (media) {
    const type = (media[2] ?? "media").toLowerCase();
    const caption = (media[1] ?? "").replace(/[\s•|]+$/g, "").replace(/\d+\s+pages?$/i, "").trim();
    return {
      kind: "media",
      text: caption || `${type} omitted`,
      extras: { media: { type } },
    };
  }

  if (!senderRaw || /end-to-end encrypted|changed their phone number|security code changed/i.test(trimmed)) {
    return { kind: "system", text: trimmed, extras: {} };
  }

  return { kind: "text", text: trimmed, extras: {} };
}

function durationSeconds(rest: string): number | undefined {
  const hours = /(\d+)\s*hr/i.exec(rest);
  const minutes = /(\d+)\s*min/i.exec(rest);
  const seconds = /(\d+)\s*sec/i.exec(rest);
  if (!hours && !minutes && !seconds) return undefined;
  return Number(hours?.[1] ?? 0) * 3600 + Number(minutes?.[1] ?? 0) * 60 + Number(seconds?.[1] ?? 0);
}
