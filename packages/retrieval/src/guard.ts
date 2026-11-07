import { RetrievalError } from "./errors";

/**
 * Retrieval tests and evals refuse anything that is not a local database whose name contains "test".
 * Call this before opening a connection. Never point it at the hosted database.
 */
export function assertLocalTestDatabase(connectionString: string): void {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new RetrievalError("invalid_input", "retrieval tests refuse a database URL they cannot read");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new RetrievalError("invalid_input", "retrieval tests refuse a database that is not on localhost");
  }
  const name = decodeURIComponent(url.pathname.replace(/^\//, "")).split("?")[0] ?? "";
  if (!name.toLowerCase().includes("test")) {
    throw new RetrievalError("invalid_input", "retrieval tests refuse a database whose name does not contain test");
  }
}
