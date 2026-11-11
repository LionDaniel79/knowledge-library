# Independent Logos ownership format

The ownership order is now `paper`, `logos`, `ebook`, `pdf`, `unknown` (종이책, 로고스, 전자책, PDF, 형식 확인 필요). Ordinary ebook statistics do not include a Logos-only holding. An explicitly selected additional ordinary ebook remains counted as that separate ownership format.

Migration041 identifies imported books by owner-matched `library_book_sources.source_kind='Logos'` or `source_data.app='Logos'`. Titles, tags and shelf names are not evidence. A proven book without `logos` replaces its old `ebook` marker with `logos`, retaining paper/PDF/unknown. Existing explicit `logos`+`ebook` arrays stay intact. New Logos imports directly write `logos`.

The migration updates only changed books' formats and increments their versions once. Original book IDs, metadata, shelf placement, cover assets, notes, cycles and existing revisions are retained. Existing sync capture publishes ordinary incremental book deltas. Rerunning041 changes neither versions nor sync heads. Triggers also handle legacy backup source links restored after their books, and protect proven ownership against stale old-format writes. No authentication/schema grants are added to the web role; the narrowly scoped book trigger reads provenance with a fixed search path.

Shared format definitions drive validation and current UI order. Server/local catalog queries and statistics, startup snapshots, ordinary backups and replica archives accept `logos`. Older startup count maps default missing Logos counts to0 while retaining the device replica and outbox.

## Verification
- Full unit suite:866 passed, four existing conditional skips.
- Browser:4 passed (ownership order and save, search options/statistics, remote catalog, import and anonymous access), using installed Chrome and isolated anonymous-test configuration.
- TypeScript and production build passed.
- Migration fixtures cover both source mechanisms, false title/tag/shelf matches, other owners, mixed formats, paper-only source links, new import/reimport, old/current backup round trips, record/history preservation and repeated full migration-runner execution.
- Two memory-device replicas received the migration incrementally without changing generation or discarding an offline outbox command; independent Logos/ebook filters and counts match the server. Replica archive export retains both the new format and unchanged pending command.
- A restricted-role regression in the initial trigger was observed and corrected;19 related permission/sync/preservation tests passed, then the full suite passed.
- Independent code review found no data/ownership/idempotency blocker.

## Deployment
For a running installation, expand only the constraint portion of041 first (no book changes), release code accepting both old/new formats, then execute full041 in one transaction. The operator's source-proven preview found2412 Logos holdings and633 ordinary ebooks; constraint expansion preserved all8250 book rows.

Take an encrypted pre-change format/version snapshot and compare all other book fields plus protected record/cover/source tables inside the migration transaction. Validate a second041 execution before commit. Private operational results are stored outside Git; do not put row UUIDs, credentials or personal records in this repository.

Old SQL migrations are unchanged. The migration runner skips the completed002 import bootstrap on an existing import schema, rather than reinstalling its obsolete format/note-kind constraints over current data. Fresh installations still run002, and041 establishes the final constraint.

The Windows PDF/OCR process and source files are outside this change. Real post-release phone/tablet UI acceptance and remote GitHub CI are not claimed by these local tests; CI remains subject to the existing account allowance.
