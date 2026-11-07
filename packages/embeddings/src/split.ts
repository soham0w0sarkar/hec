/** One transcript line that already names its message. */
export type ChunkLine = {
  id: number;
  line: string;
};

export type ChunkDraft = {
  position: number;
  firstMessageId: number;
  lastMessageId: number;
  messageCount: number;
  transcript: string;
};

export const CHUNK_LIMITS = {
  maxChars: 1800,
  maxMessages: 24,
  overlap: 4,
} as const;

/**
 * Cuts one session into overlapping chunks. A window always advances by at least one message,
 * so a line longer than the cap still makes progress.
 */
export function splitChunks(
  lines: readonly ChunkLine[],
  limits: { maxChars: number; maxMessages: number; overlap: number } = CHUNK_LIMITS,
): ChunkDraft[] {
  if (lines.length === 0) return [];
  const overlap = Math.max(0, limits.overlap);
  const ranges: [number, number][] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let chars = 0;
    while (end < lines.length && end - start < limits.maxMessages) {
      const next = lines[end]!.line.length + 1;
      if (end > start && chars + next > limits.maxChars) break;
      chars += next;
      end += 1;
    }
    ranges.push([start, end]);
    if (end >= lines.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return ranges.map(([from, to], position) => {
    const slice = lines.slice(from, to);
    const first = slice[0]!;
    const last = slice[slice.length - 1]!;
    return {
      position,
      firstMessageId: first.id,
      lastMessageId: last.id,
      messageCount: slice.length,
      transcript: slice.map((item) => item.line).join("\n"),
    };
  });
}
