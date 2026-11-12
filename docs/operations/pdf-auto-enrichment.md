# Bounded PDF enrichment

`scripts/complete-pdfs.ts --limit 20` previews candidates. Add `--apply` only after reviewing the preview. The maximum is 100 automatic adoptions per invocation; operators must also enforce their cumulative approval ceiling across runs. No scheduler is started.

Use the existing private runtime environment for DATABASE_URL, LIBRARY_CATALOG_OWNER_ID and provider credentials. Set LIBRARY_PDF_ROOT, LIBRARY_PDF_INDEX, CATALOG_CACHE_DIR, PDF_AUTO_REPORT_DIR and PDF_IDENTITY_PYTHON (the installed OCR interpreter). Writes require the existing LIBRARY_STAGE5_WRITE_ENABLED gate. Run from the repository root using the existing tsx loader. Never commit environment files or private reports.

The original SQLite index is read-only. Identification reads only the first 12 and last 8 pages, deduplicating short documents. Existing metadata/OCR pages and bibliography caches precede external discovery. Only missing/unresolved frontier pages can use the existing Windows OCR engine; supplementary evidence is stored separately. Attempts are bounded to 20 frontier pages and 160 metadata API requests per invocation. A failed OCR probe leaves a private marker requiring inspection before another OCR probe. It never authorizes resetting the production index.

Existing displayed covers, automatic adoption records and user removals are preserved. Same-work adoption uses shared provider comparisons plus bounded PDF ISBN evidence. Uncertain ISBNs remain references; only the existing strict native-text identity resolution permits a blank original ISBN to be filled. Original ISBN changes use the same before/after audit and field-level undo as other adopted fields. Strongly conflicting authors/volumes, ambiguous candidates, reader edits and rejected candidates remain protected.

Preview and apply reports distinguish searched, eligible, adopted, source unavailable, review, missing and request-budget stop. A budget stop is not proof of completion. Lookup failures are not silently reclassified as no candidates on subsequent runs. Provider credentials, full paths and page excerpts belong only in the private evidence directory.

The general/PDF scheduled collector remains paused. Logos scheduling and its checkpoints are independent. Coordinate finite PDF runs outside Logos execution; both reuse the shared quota ledger. No PDF-wide re-OCR, file movement or database migration is required.
