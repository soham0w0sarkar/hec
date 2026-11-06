import { readFile } from "node:fs/promises";
import { PERSON_IDS, type MessageSource, type PersonId } from "@hec/core";
import type { DateOrder, HourClock } from "./adapters/whatsapp/parse";
import { IngestError } from "./errors";

export type IngestConfig = {
  identity: Record<MessageSource, Record<string, PersonId>>;
  whatsapp: {
    dateOrder?: DateOrder;
    hourClock?: HourClock;
  };
};

const PERSON_ID_SET = new Set<string>(PERSON_IDS);

export async function loadIngestConfig(path: string): Promise<IngestConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new IngestError(`Missing ${path}. Map each export name to ${PERSON_IDS.join(" or ")}.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new IngestError(`${path}: ${message}`);
  }

  return parseIngestConfig(parsed);
}

export function parseIngestConfig(value: unknown): IngestConfig {
  if (!isRecord(value)) throw new IngestError("ingest config must be an object");
  if (!isRecord(value.identity)) throw new IngestError("ingest config needs an identity object");

  return {
    identity: {
      instagram: names(value.identity.instagram, "instagram"),
      whatsapp: names(value.identity.whatsapp, "whatsapp"),
    },
    whatsapp: whatsAppOptions(value.whatsapp),
  };
}

function names(value: unknown, source: MessageSource): Record<string, PersonId> {
  if (!isRecord(value)) throw new IngestError(`identity.${source} must be an object`);
  const mapped: Record<string, PersonId> = {};
  for (const [rawName, personId] of Object.entries(value)) {
    if (rawName.trim() === "") throw new IngestError(`identity.${source} has an empty name`);
    if (typeof personId !== "string" || !PERSON_ID_SET.has(personId)) {
      throw new IngestError(`identity.${source}.${rawName} must be ${PERSON_IDS.join(" or ")}`);
    }
    mapped[rawName] = personId as PersonId;
  }
  return mapped;
}

function whatsAppOptions(value: unknown): IngestConfig["whatsapp"] {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new IngestError("whatsapp options must be an object");
  const dateOrder = value.dateOrder;
  const hourClock = value.hourClock;
  if (dateOrder !== undefined && dateOrder !== "DMY" && dateOrder !== "MDY") {
    throw new IngestError("whatsapp.dateOrder must be DMY or MDY");
  }
  if (hourClock !== undefined && hourClock !== "12" && hourClock !== "24" && hourClock !== "auto") {
    throw new IngestError("whatsapp.hourClock must be 12, 24, or auto");
  }
  return {
    dateOrder,
    hourClock,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
