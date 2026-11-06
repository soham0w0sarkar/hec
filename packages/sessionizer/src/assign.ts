import { createHash } from "node:crypto";

/** Message ids per update. One statement, small enough to send through the pooler. */
export const ASSIGN_BATCH = 5000;

export type Assignment = {
  id: number;
  sessionId: number;
};

export type AssignmentSlice = {
  key: string;
  rows: { id: number; session_id: number }[];
};

/** Splits assignments into disjoint slices. A session may span two slices. */
export function assignmentSlices(assignments: Assignment[], batchSize = ASSIGN_BATCH): AssignmentSlice[] {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`batch size must be a positive integer, got ${batchSize}`);
  }

  const slices: AssignmentSlice[] = [];
  for (let offset = 0; offset < assignments.length; offset += batchSize) {
    const rows = assignments.slice(offset, offset + batchSize).map((row) => ({
      id: row.id,
      session_id: row.sessionId,
    }));
    slices.push({ key: sliceKey(rows), rows });
  }
  return slices;
}

function sliceKey(rows: { id: number }[]): string {
  return createHash("sha256").update(rows.map((row) => String(row.id)).join(",")).digest("hex");
}
