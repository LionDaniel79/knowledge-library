import type { Pool } from "pg";
import type { Database } from "../library-store";
export function createPoolDatabase(pool: Pool): Database {
  return {
    query: (sql, params = []) => pool.query(sql, params),
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({
          query: (sql, params = []) => client.query(sql, params),
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
