import { readFile } from "node:fs/promises";
import { Pool } from "pg";
const url = process.env.DATABASE_URL_UNPOOLED;
if (!url)
  throw Error(
    "DATABASE_URL_UNPOOLED is required; migrations need a direct connection.",
  );
const pool = new Pool({ connectionString: url, max: 1 });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(await readFile("db/001_library.sql", "utf8"));
  await client.query(await readFile("db/002_ireaditnow.sql", "utf8"));
  await client.query(await readFile("db/003_reading_history.sql", "utf8"));
  await client.query(await readFile("db/004_pdf_library.sql", "utf8"));
  await client.query(await readFile("db/005_knowledge.sql", "utf8"));
  await client.query(await readFile("db/006_catalog.sql", "utf8"));
  await client.query(await readFile("db/007_thought_map.sql", "utf8"));
  await client.query(await readFile("db/008_thought_jobs.sql", "utf8"));
  await client.query(await readFile("db/009_analysis_devices.sql", "utf8"));
  await client.query(await readFile("db/010_library_ai_policy.sql", "utf8"));
  await client.query(await readFile("db/011_library_curation.sql", "utf8"));
  await client.query(await readFile("db/012_library_assist.sql", "utf8"));
  await client.query(await readFile("db/013_pdf_processing_scope.sql", "utf8"));
  await client.query(await readFile("db/014_document_references.sql", "utf8"));
  await client.query(await readFile("db/015_book_relations.sql", "utf8"));
  await client.query(
    await readFile("db/016_research_organization.sql", "utf8"),
  );
  const role = process.env.LIBRARY_APP_ROLE;
  await client.query(await readFile("db/017_note_trash.sql", "utf8"));
  await client.query(await readFile("db/018_cover_assets.sql", "utf8"));
  if (role) {
    if (!/^[a-z_][a-z0-9_]*$/.test(role))
      throw Error("Invalid application role");
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON library_cover_assets TO "' + role + '"',
    );
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON library_note_trash TO "' + role + '"',
    );
    await client.query(
      'GRANT SELECT ON library_active_notes TO "' + role + '"',
    );
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON library_research_placements,library_external_links TO "' +
        role +
        '"',
    );
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON library_book_relations TO "' + role + '"',
    );
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON library_ai_usage,library_assist_requests,library_assist_results,library_assist_workers TO "' +
        role +
        '"',
    );
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON library_topics,library_topic_memberships,library_topic_links,library_thought_events,library_evolution_candidates TO "' +
        role +
        '"',
    );
    await client.query(
      'GRANT SELECT,INSERT ON library_analysis_feedback TO "' + role + '"',
    );
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON library_thought_jobs,library_analysis_workers TO "' +
        role +
        '"',
    );
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON library_analysis_devices,library_worker_limits TO "' +
        role +
        '"',
    );
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON library_ai_policy TO "' + role + '"',
    );
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON library_curation_runs,library_curation_items,library_reference_sources,library_field_origins TO "' +
        role +
        '"',
    );
    await client.query('GRANT USAGE ON SCHEMA public TO "' + role + '"');
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON library_annual_metrics TO "' + role + '"',
    );
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON library_connections,library_research,library_research_items TO "' +
        role +
        '"',
    );
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON library_documents,library_shelves TO "' +
        role +
        '"',
    );
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON library_books,library_cycles,library_notes,library_operations TO "' +
        role +
        '"',
    );
    await client.query(
      'GRANT SELECT,INSERT ON library_revisions,library_imports TO "' +
        role +
        '"',
    );
  }
  await client.query("COMMIT");
  console.log("Library schema applied successfully.");
} catch (e) {
  await client.query("ROLLBACK");
  console.error(
    "Migration failed",
    e instanceof Error ? e.message : "Unknown error",
  );
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
