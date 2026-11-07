export type RetrievalErrorCode = "invalid_input" | "timeout" | "model_mismatch";

/** A caller mistake, a database timeout, or vectors from another embedding model. An empty result is not an error. */
export class RetrievalError extends Error {
  readonly code: RetrievalErrorCode;

  constructor(code: RetrievalErrorCode, message: string) {
    super(message);
    this.name = "RetrievalError";
    this.code = code;
  }
}

export function mapQueryError(error: unknown): Error {
  if (error instanceof RetrievalError) return error;
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : "";
  if (code === "57014" || /statement timeout/i.test(message)) {
    return new RetrievalError("timeout", "query timed out");
  }
  return error instanceof Error ? error : new Error("query failed");
}
