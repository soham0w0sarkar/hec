import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "@hec/db";
import { runIngest, type IngestFileReport } from "./run";
import { parseWorkerCount } from "./workers";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

if (import.meta.main) {
  const workers = parseWorkerCount(process.argv.slice(2), process.env.INGEST_WORKERS);
  const sql = createDb(process.env.DATABASE_URL, { max: workers + 1 });
  const startedAt = Date.now();
  try {
    console.log(`ingest with ${workers} workers`);
    const reports = await runIngest({
      sql,
      rawDir: join(repoRoot, "data/raw"),
      configPath: join(repoRoot, "data/ingest.json"),
      workers,
      onReport: printReport,
    });

    const inserted = reports.reduce((total, report) => total + report.rowsInserted, 0);
    const byStatus = new Map<string, number>();
    for (const report of reports) byStatus.set(report.status, (byStatus.get(report.status) ?? 0) + 1);
    const statuses = [...byStatus.entries()].map(([status, count]) => `${status} ${count}`).join(", ");
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`done in ${seconds}s: ${statuses}; inserted ${inserted}`);

    if (reports.some((report) => report.status === "failed")) process.exitCode = 1;
  } finally {
    await sql.close();
  }
}

function printReport(report: IngestFileReport): void {
  const counts = `seen=${report.rowsSeen} inserted=${report.rowsInserted} skipped=${report.rowsSkipped}`;
  const detail = report.status === "locked" ? "held by another worker" : counts;
  console.log(`[w${report.worker}] ${report.status} ${report.source} ${report.fileName} ${detail}`);
  for (const warning of report.warnings) console.log(`  ${warning}`);
  if (report.error) console.error(`  ${report.error}`);
}
