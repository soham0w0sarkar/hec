import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SQL } from "bun";
import type { MessageSource } from "@hec/core";
import { parseInstagramExport } from "./adapters/instagram/parse";
import { parseWhatsAppExport } from "./adapters/whatsapp/parse";
import { assertNoLargeReversal, assertNotFuture, smallReversals } from "./checks";
import { loadIngestConfig, type IngestConfig } from "./config";
import { withoutDuplicates } from "./dedupe";
import { runPool } from "./pool";
import { resolveSenders } from "./resolve";
import {
  hasSucceeded,
  hashBytes,
  insertMessages,
  loadDisplayTimezone,
  recordRun,
  bumpDataVersion,
  refreshDailyStats,
  replaceIdentities,
  storedForDedupe,
  tryLockFile,
  waitForOtherSources,
} from "./store";
import type { ParsedMessage } from "./types";

export const DEFAULT_INGEST_WORKERS = 4;

/** `locked`: another worker or process holds the file. `skipped`: an earlier run stored it. */
export type IngestFileStatus = "succeeded" | "failed" | "skipped" | "locked";

export type IngestFileReport = {
  source: MessageSource;
  fileName: string;
  worker: number;
  status: IngestFileStatus;
  rowsSeen: number;
  rowsInserted: number;
  rowsSkipped: number;
  warnings: string[];
  error?: string;
};

export type RunIngestOptions = {
  sql: SQL;
  rawDir: string;
  configPath: string;
  workers?: number;
  now?: Date;
  onReport?: (report: IngestFileReport) => void;
};

type ExportFile = { source: MessageSource; fileName: string; path: string };

type FileContext = {
  config: IngestConfig;
  timeZone: string;
  now: Date;
  worker: number;
};

export async function runIngest(options: RunIngestOptions): Promise<IngestFileReport[]> {
  const now = options.now ?? new Date();
  const config = await loadIngestConfig(options.configPath);
  const timeZone = await loadDisplayTimezone(options.sql);
  await replaceIdentities(options.sql, config);

  const files = await listExports(options.rawDir);
  const reports = await runPool(files, options.workers ?? DEFAULT_INGEST_WORKERS, async (file, worker) => {
    const report = await ingestFile(options.sql, file, { config, timeZone, now, worker });
    options.onReport?.(report);
    return report;
  });

  if (reports.some((report) => report.rowsInserted > 0)) await refreshDailyStats(options.sql);
  return reports;
}

/** Claims, parses, and stores one file in a single transaction. A crash rolls all of it back. */
async function ingestFile(sql: SQL, file: ExportFile, context: FileContext): Promise<IngestFileReport> {
  const report = (fields: Partial<IngestFileReport> & Pick<IngestFileReport, "status">): IngestFileReport => ({
    source: file.source,
    fileName: file.fileName,
    worker: context.worker,
    rowsSeen: 0,
    rowsInserted: 0,
    rowsSkipped: 0,
    warnings: [],
    ...fields,
  });

  const bytes = await readFile(file.path);
  const fileHash = hashBytes(bytes);
  const startedAt = new Date();
  let seen = 0;

  try {
    return await sql.begin(async (tx): Promise<IngestFileReport> => {
      if (!(await tryLockFile(tx, file.source, fileHash))) return report({ status: "locked" });
      if (await hasSucceeded(tx, file.source, fileHash)) return report({ status: "skipped" });
      // Supabase's 2 min default can expire while waiting for the other app's files.
      await tx`set local statement_timeout = '10min'`;

      const parsed = parseFile(file, bytes, context);
      seen = parsed.length;
      const warnings = file.source === "whatsapp" ? smallReversals(parsed, file.fileName) : [];
      if (file.source === "whatsapp") assertNoLargeReversal(parsed, file.fileName);
      assertNotFuture(parsed, context.now, file.fileName);
      // WhatsApp's encryption notice has a time and no sender. It is not a message from either person.
      const addressed = parsed.filter((message) => message.senderRaw !== "" || message.kind !== "system");
      const resolved = resolveSenders(addressed, context.config.identity[file.source], file.fileName);

      await waitForOtherSources(tx, file.source);
      const kept = withoutDuplicates(resolved, await storedForDedupe(tx, resolved, file.source));
      const inserted = await insertMessages(tx, kept);
      const skipped = seen - inserted;
      await recordRun(tx, {
        source: file.source,
        fileName: file.fileName,
        fileHash,
        startedAt,
        seen,
        status: "succeeded",
        inserted,
        skipped,
      });
      // Rolls back with the insert if this transaction does not commit.
      if (inserted > 0) await bumpDataVersion(tx);

      return report({ status: "succeeded", rowsSeen: seen, rowsInserted: inserted, rowsSkipped: skipped, warnings });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "ingest failed";
    await recordRun(sql, {
      source: file.source,
      fileName: file.fileName,
      fileHash,
      startedAt,
      seen,
      status: "failed",
      error: message,
    });
    return report({ status: "failed", rowsSeen: seen, error: message });
  }
}

function parseFile(file: ExportFile, bytes: Uint8Array, context: FileContext): ParsedMessage[] {
  const contents = new TextDecoder().decode(bytes);
  if (file.source === "instagram") return parseInstagramExport(file.fileName, contents).messages;
  return parseWhatsAppExport(file.fileName, contents, { timeZone: context.timeZone, ...context.config.whatsapp });
}

async function listExports(rawDir: string): Promise<ExportFile[]> {
  const instagramDir = join(rawDir, "instagram");
  const whatsappDir = join(rawDir, "whatsapp");
  const instagram = (await readdir(instagramDir))
    .filter((name) => name.endsWith(".json"))
    .sort(byMessageFile)
    .map((fileName) => ({ source: "instagram" as const, fileName, path: join(instagramDir, fileName) }));
  const whatsapp = (await readdir(whatsappDir))
    .filter((name) => name.endsWith(".txt"))
    .sort()
    .map((fileName) => ({ source: "whatsapp" as const, fileName, path: join(whatsappDir, fileName) }));
  return [...instagram, ...whatsapp];
}

function byMessageFile(a: string, b: string): number {
  return fileNumber(a) - fileNumber(b) || a.localeCompare(b);
}

function fileNumber(name: string): number {
  return Number(/(\d+)/.exec(name)?.[1] ?? 0);
}
