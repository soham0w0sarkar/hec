import { DEFAULT_INGEST_WORKERS } from "./run";

export const MAX_INGEST_WORKERS = 16;

/** Reads `--workers N` or `--workers=N`, falling back to INGEST_WORKERS, then the default. */
export function parseWorkerCount(argv: string[], env: string | undefined): number {
  const index = argv.findIndex((arg) => arg === "--workers" || arg.startsWith("--workers="));
  const flag = index === -1 ? undefined : argv[index];
  const raw = flag === undefined ? env : flag.includes("=") ? flag.slice(flag.indexOf("=") + 1) : argv[index + 1];
  if (raw === undefined || raw.trim() === "") return DEFAULT_INGEST_WORKERS;

  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1 || count > MAX_INGEST_WORKERS) {
    throw new Error(`workers must be a whole number from 1 to ${MAX_INGEST_WORKERS}, got "${raw}"`);
  }
  return count;
}
