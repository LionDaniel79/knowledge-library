import { database } from "../src/server/db";
import { backfillImportedRatings } from "../src/server/reading-rating-import";
// Supply the existing private environment file; never accept/display a connection URL here.
if (!process.env.LIBRARY_OWNER_EMAIL) throw Error("소유자 설정이 필요합니다.");
const rows = await database.query(
  'SELECT id FROM neon_auth."user" WHERE lower(email)=lower($1)',
  [process.env.LIBRARY_OWNER_EMAIL],
);
if (rows.rows.length !== 1) throw Error("소유자를 하나로 확인할 수 없습니다.");
console.log(
  JSON.stringify(
    await backfillImportedRatings(
      database,
      rows.rows[0].id,
      process.argv.includes("--apply"),
    ),
  ),
);
