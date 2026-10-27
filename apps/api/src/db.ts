import postgres from "postgres";

/**
 * Database access as the API's least-privilege role (envsync_api). Every query runs inside a
 * transaction that first records which user the API acts for; Row Level Security then limits it to
 * that user's workspaces, so a mistake in a query cannot reach another user's data.
 */

export type Tx = postgres.TransactionSql;

export type Database = {
  withUser<T>(userId: string, work: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

export function createDatabase(url: string): Database {
  const sql = postgres(url, {
    ssl: "require",
    max: 10,
    connect_timeout: 15,
    idle_timeout: 30,
    // Supabase's pooler in transaction mode does not support prepared statements.
    prepare: false,
    onnotice: () => {},
  });
  return {
    withUser: (userId, work) =>
      sql.begin(async (tx) => {
        await tx`select set_config('envsync.user_id', ${userId}, true)`;
        return work(tx);
      }) as Promise<never>,
    close: () => sql.end({ timeout: 5 }),
  };
}
