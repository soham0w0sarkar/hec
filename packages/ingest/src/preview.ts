import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DISPLAY_TIMEZONE } from "@hec/core";
import { parseInstagramExport } from "./adapters/instagram/parse";
import { parseWhatsAppExport } from "./adapters/whatsapp/parse";
import type { ParsedMessage } from "./types";

const rawDir = join(dirname(fileURLToPath(import.meta.url)), "../../..", "data/raw");
const now = new Date();

const instagram = await parseInstagram(join(rawDir, "instagram"));
const whatsapp = await parseWhatsApp(join(rawDir, "whatsapp"));

console.log(formatReport("instagram", instagram));
console.log(formatReport("whatsapp", whatsapp));

async function parseInstagram(dir: string): Promise<ParsedMessage[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort(byMessageFile);
  let repairedFields = 0;
  const messages: ParsedMessage[] = [];
  for (const file of files) {
    const result = parseInstagramExport(file, await readFile(join(dir, file), "utf8"));
    messages.push(...result.messages);
    repairedFields += result.repairedFields;
  }
  console.log(`instagram files ${files.length}, repaired fields ${repairedFields}`);
  return messages;
}

async function parseWhatsApp(dir: string): Promise<ParsedMessage[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith(".txt")).sort();
  const messages: ParsedMessage[] = [];
  for (const file of files) {
    const parsed = parseWhatsAppExport(file, await readFile(join(dir, file), "utf8"), {
      timeZone: DISPLAY_TIMEZONE,
    });
    const jumps = backwardsJumps(parsed);
    console.log(`whatsapp ${file}: ${parsed.length} messages, ${jumps.length} backwards jumps`);
    for (const jump of jumps.slice(0, 5)) console.log(`  ${jump}`);
    messages.push(...parsed);
  }
  return messages;
}

function formatReport(source: string, messages: ParsedMessage[]): string {
  const senders = count(messages.map((message) => message.senderRaw || "(none)"));
  const kinds = count(messages.map((message) => message.kind));
  const times = messages.map((message) => message.sentAt.getTime()).filter(Number.isFinite);
  const future = messages.filter((message) => message.sentAt.getTime() > now.getTime() + 60_000).length;
  const multiline = messages.filter((message) => message.sourceRef.includes("-") && span(message.sourceRef) > 1).length;
  const sorted = [...times].sort((a, b) => a - b);
  const lines = [
    "",
    source,
    `  messages ${messages.length}`,
    `  senders ${formatCounts(senders)}`,
    `  kinds ${formatCounts(kinds)}`,
    `  from ${stamp(sorted[0])} to ${stamp(sorted.at(-1))}`,
    `  future ${future}`,
    `  multiline ${multiline}`,
    "  sample",
    ...messages.slice(0, 3).map(shape),
    ...messages.slice(-1).map(shape),
  ];
  return lines.join("\n");
}

function shape(message: ParsedMessage): string {
  const extras = Object.keys(message.extras);
  return `    ${message.sourceRef} ${message.kind} ${stamp(message.sentAt.getTime())} sender=${message.senderRaw || "(none)"} chars=${message.text.length} extras=${extras.join(",") || "-"}`;
}

function backwardsJumps(messages: ParsedMessage[]): string[] {
  const jumps: string[] = [];
  for (let i = 1; i < messages.length; i++) {
    const previous = messages[i - 1];
    const current = messages[i];
    if (!previous || !current) continue;
    if (current.sentAt.getTime() + 1000 < previous.sentAt.getTime()) {
      jumps.push(`${current.sourceRef} ${stamp(current.sentAt.getTime())} before ${stamp(previous.sentAt.getTime())}`);
    }
  }
  return jumps;
}

function span(sourceRef: string): number {
  const match = /(\d+)-(\d+)$/.exec(sourceRef);
  if (!match) return 1;
  return Number(match[2]) - Number(match[1]) + 1;
}

function count(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function formatCounts(counts: Map<string, number>): string {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, total]) => `${name} ${total}`)
    .join(", ");
}

function stamp(ms: number | undefined): string {
  if (ms === undefined) return "-";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: DISPLAY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
}

function byMessageFile(a: string, b: string): number {
  return fileNumber(a) - fileNumber(b) || a.localeCompare(b);
}

function fileNumber(name: string): number {
  return Number(/(\d+)/.exec(name)?.[1] ?? 0);
}
