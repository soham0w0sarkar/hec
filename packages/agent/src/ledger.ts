import type { EventCategory, MessageKind, MessageSource, PersonId } from "@hec/core";

/** A message a tool actually returned. `text` is the stored original. Intimate lines stay here and off the model. */
export type LedgerMessage = {
  id: number;
  personId: PersonId;
  name: string;
  source: MessageSource;
  sentAt: string;
  sentAtIst: string;
  text: string;
  kind: MessageKind;
  intimate: boolean;
};

export type RankedLook = {
  tool: "find_first" | "find_last";
  hitId: number | null;
  runnerIds: number[];
  byPerson: { personId: PersonId; hitId: number | null }[];
  bySource: { source: MessageSource; hitId: number | null }[];
};

export type LedgerEvent = {
  id: number;
  category: EventCategory;
  date: string;
  quote: string | null;
  evidenceIds: number[];
};

export type Ledger = {
  messages: Map<number, LedgerMessage>;
  tools: string[];
  variants: string[];
  dateRanges: { from: string | null; until: string | null }[];
  looks: RankedLook[];
  events: LedgerEvent[];
  /** Integers from count and stats results. Message ids are not figures. */
  figures: Set<number>;
  /** Calendar days mentioned by a stats result. */
  statDates: Set<string>;
};

export function createLedger(): Ledger {
  return {
    messages: new Map(),
    tools: [],
    variants: [],
    dateRanges: [],
    looks: [],
    events: [],
    figures: new Set(),
    statDates: new Set(),
  };
}

export function rememberTool(ledger: Ledger, name: string, input: Record<string, unknown>): void {
  if (!ledger.tools.includes(name)) ledger.tools.push(name);
  const texts = [input.text, ...(Array.isArray(input.variants) ? input.variants : [])];
  for (const value of texts) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length === 0 || ledger.variants.includes(trimmed) || ledger.variants.length >= 32) continue;
    ledger.variants.push(trimmed);
  }
  const from = typeof input.from === "string" ? input.from : typeof input.from_day === "string" ? input.from_day : null;
  const until = typeof input.until === "string" ? input.until : typeof input.until_day === "string" ? input.until_day : null;
  const day = typeof input.day === "string" ? input.day : null;
  if (from || until) ledger.dateRanges.push({ from, until });
  if (day) ledger.dateRanges.push({ from: day, until: null });
}

export function rememberMessage(ledger: Ledger, message: LedgerMessage): void {
  if (!ledger.messages.has(message.id)) ledger.messages.set(message.id, message);
}

export function collectFigures(value: unknown, ledger: Ledger): void {
  if (typeof value === "number" && Number.isInteger(value)) {
    ledger.figures.add(value);
    return;
  }
  if (typeof value === "string") {
    const day = /^(\d{4}-\d{2}-\d{2})/.exec(value);
    if (day?.[1]) ledger.statDates.add(day[1]);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFigures(item, ledger);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectFigures(item, ledger);
  }
}
