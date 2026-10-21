import { it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { metadataPagesTable } from "../src/local/curation/pdf-metadata-pages";
it("uses preserved front-matter OCR for metadata while keeping old indexes compatible", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE pages(document_id TEXT,page_number INTEGER,text TEXT,method TEXT)",
    );
    expect(metadataPagesTable(db)).toBe("pages");
    db.exec("CREATE VIEW pages_metadata AS SELECT * FROM pages");
    expect(metadataPagesTable(db)).toBe("pages_metadata");
  } finally {
    db.close();
  }
});
