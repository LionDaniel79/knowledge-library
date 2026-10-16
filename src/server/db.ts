import { Pool } from "pg";
import { dateOnlyTypes } from "./pg-types";
import { attachDatabasePool } from "@vercel/functions";
import {
  createLibraryStore,
  LibraryError,
  type Database,
} from "./library-store";
let pool: Pool | undefined;
function getPool() {
  if (!process.env.DATABASE_URL)
    throw new LibraryError(503, "온라인 DB 연결 설정이 필요합니다.");
  if (!pool) {
    pool = new Pool({
      types: dateOnlyTypes,
      connectionString: process.env.DATABASE_URL,
      max: 4,
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 15000,
    });
    attachDatabasePool(pool);
  }
  return pool;
}
export const database: Database = {
  query: async (text, params = []) => getPool().query(text, params),
  transaction: async (fn) => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const result = await fn({
        query: async (text, params = []) => client.query(text, params),
      });
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  },
};
export function getStore() {
  return createLibraryStore(database);
}
