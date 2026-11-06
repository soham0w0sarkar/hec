import { SQL } from "bun";

export type Database = SQL;

export type CreateDbOptions = {
  max?: number;
};

function useTls(connectionString: string): boolean {
  const host = new URL(connectionString).hostname;
  return host !== "localhost" && host !== "127.0.0.1";
}

export function createDb(connectionString = process.env.DATABASE_URL, options: CreateDbOptions = {}): Database {
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  return new SQL(connectionString, {
    // The Supabase transaction pooler rejects named prepared statements.
    prepare: false,
    max: options.max ?? 5,
    tls: useTls(connectionString),
    // On Supabase, vector and pg_trgm are installed in the extensions schema.
    connection: { search_path: "public, extensions" },
  });
}
