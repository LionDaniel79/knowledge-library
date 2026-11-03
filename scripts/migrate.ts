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
  if (role && !/^[a-z_][a-z0-9_]*$/.test(role))
    throw Error("Invalid application role");
  await client.query(await readFile("db/017_note_trash.sql", "utf8"));
  await client.query(await readFile("db/018_cover_assets.sql", "utf8"));
  await client.query(await readFile("db/019_server_assist.sql", "utf8"));
  await client.query(await readFile("db/020_mcp_oauth.sql", "utf8"));
  await client.query(await readFile("db/021_catalog_reviews.sql", "utf8"));
  await client.query(await readFile("db/022_book_introductions.sql", "utf8"));
  await client.query(await readFile("db/023_cover_mirrors.sql", "utf8"));
  await client.query(await readFile("db/024_empty_note_trash.sql", "utf8"));
  await client.query(await readFile("db/025_book_exclusions.sql", "utf8"));
  await client.query(await readFile("db/026_device_sync.sql", "utf8"));
  await client.query(await readFile("db/027_library_archives.sql", "utf8"));
  await client.query(await readFile("db/028_whiteboard.sql", "utf8"));
  await client.query(await readFile("db/029_scoped_whiteboards.sql", "utf8"));
  await client.query(await readFile("db/030_delete_research.sql", "utf8"));
  await client.query(await readFile("db/031_thought_bundles.sql", "utf8"));
  await client.query(await readFile("db/032_connection_titles.sql", "utf8"));
  await client.query(
    await readFile("db/033_shared_thought_titles.sql", "utf8"),
  );
  await client.query(await readFile("db/034_book_deletion.sql", "utf8"));
  await client.query(
    await readFile("db/035_desktop_catalog_and_logos.sql", "utf8"),
  );
  if (role) {
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON library_desktop_tokens,library_desktop_manifests,library_desktop_manifest_items,library_book_sources,library_pdf_registry,library_cover_locations TO "' +
        role +
        '"',
    );
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON library_memo_bundles,library_bundle_links TO "' +
        role +
        '"',
    );
    await client.query(
      'GRANT EXECUTE ON FUNCTION public.library_delete_research(text,uuid) TO "' +
        role +
        '"',
    );
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON library_whiteboards TO "' + role + '"',
    );
    await client.query(
      'GRANT SELECT ON library_sync_heads,library_sync_changes,library_sync_row_versions TO "' +
        role +
        '"',
    );
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON library_sync_devices TO "' + role + '"',
    );
    await client.query(
      'GRANT EXECUTE ON FUNCTION public.library_sync_lock(text),public.library_sync_redact(jsonb) TO "' +
        role +
        '"',
    );
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON library_book_exclusions TO "' + role + '"',
    );
    await client.query(
      'GRANT SELECT ON library_active_books,library_active_documents,library_active_cycles TO "' +
        role +
        '"',
    );
    await client.query(
      'GRANT EXECUTE ON FUNCTION public.library_empty_note_trash(text,jsonb) TO "' +
        role +
        '"',
    );
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON library_cover_mirrors TO "' + role + '"',
    );
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON library_book_introductions TO "' +
        role +
        '"',
    );
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON library_catalog_reviews TO "' + role + '"',
    );
    if (!/^[a-z_][a-z0-9_]*$/.test(role))
      throw Error("Invalid application role");
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON library_assist_receipts TO "' + role + '"',
    );
    await client.query(
      'GRANT SELECT,INSERT,UPDATE ON library_mcp_codes,library_mcp_tokens TO "' +
        role +
        '"',
    );
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
