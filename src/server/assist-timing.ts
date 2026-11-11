import type { Database, Executor } from "./library-store";
/** Per-request counters only: no query text, identifiers or content is retained. */
export function measureAssistDatabase(database: Database) {
  let sqlMs = 0,
    txMs = 0,
    count = 0;
  const wrap = (tx: Executor): Executor => ({
    query: async (sql, values) => {
      const at = performance.now();
      count++;
      try {
        return await tx.query(sql, values);
      } finally {
        sqlMs += performance.now() - at;
      }
    },
  });
  const db: Database = {
    ...wrap(database),
    transaction: async (fn) => {
      const at = performance.now();
      try {
        return await database.transaction((tx) => fn(wrap(tx)));
      } finally {
        txMs += performance.now() - at;
      }
    },
  };
  return {
    db,
    header: () =>
      `db_tx;dur=${txMs.toFixed(1)}, db_sql;dur=${sqlMs.toFixed(1)}, db_queries;desc="${count}"`,
  };
}
