-- Existing external provenance remains readable; newly confirmed Logos covers
-- point at durable, owner-scoped assets replicated with the library.
ALTER TABLE library_cover_locations DROP CONSTRAINT IF EXISTS library_cover_locations_storage_kind_check;
ALTER TABLE library_cover_locations ADD CONSTRAINT library_cover_locations_storage_kind_check
  CHECK(storage_kind IN ('external','neon_object','managed_asset'));
