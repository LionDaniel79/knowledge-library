import { DatabaseSync } from "node:sqlite";
import { searchPdfRows } from "../src/local/pdf-search.mjs";
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 16384) throw Error("Search input too large");
}
const { indexPath, query, documentId } = JSON.parse(input);
const db = new DatabaseSync(indexPath, { readOnly: true });
try {
  db.exec("PRAGMA busy_timeout=1000; PRAGMA query_only=ON");
  process.stdout.write(JSON.stringify(searchPdfRows(db, query, documentId)));
} finally {
  db.close();
}
