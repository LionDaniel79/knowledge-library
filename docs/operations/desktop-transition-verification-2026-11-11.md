# Desktop transition continuation — 2026-11-11

This record supersedes the pending production/cutover status in the November5 milestone. User approval covered the exact reviewed production transition and legacy-server retirement. It does not mean that background OCR or all optional cover discovery has finished.

## Released and verified

- PR10/11/12 merged and production deployed. The native application replaces the old HTTP server. The old HTTP and OCR scheduled tasks are disabled, with private rollback definitions retained; port3001 is closed. Browser profiles, IndexedDB, Tailscale configuration and original PDF/index files were not reset.
- Actual inventory:9319 physical PDFs; selected roots4109 copies and4108 legacy IDs, no missing/additional selected IDs. Shared content resources8451. A checksum-verified management snapshot restored successfully; schema3 migration and cached rescan retained all resource IDs,9900 original local OCR pages,207152 original queue rows and31 immutable request bodies. No original PDF/legacy-index writes.
- Native installed under the external working runtime, with management state on a private internal SSD. The recovered application is actually advancing its existing page queue. Closing to tray retains background work. Approved-root bibliography/location HTTPS sync completed with pending0 and existing exclusions36 retained.
- The reviewed purge completed November5:5173 web bibliography records and their explicitly approved generated data;40 held. Do not replay it. Logos2412 imported, six ambiguous editions held.
- Fresh encrypted online backup: all70 public/neon_auth tables restored into isolated PostgreSQL18; row counts and SHA-256 content/schema fingerprints match, mismatch0. AES-256-GCM authenticated decryption and a second physical-device encrypted copy verified. Native management SQLite also encrypted, decrypted and integrity-checked. The local restore server was then stopped.
- Nine protected personal tables still match the backup snapshot after registration/enrichment acceptance.

## Final live fixes

- The restricted collector cannot read the authentication schema. A verified owner UUID from its trusted DPAPI profile now identifies Logos work without adding authentication-table grants. This configuration has no web-request entry point; malformed IDs fail before SQL. Older operator installations retain parameterized email lookup.
- A malformed provider JSON response stopped discovery after86 resources. The final runner defers only that resource, continues later books, and persists bounded60/120-second retries. Three failures leave it quarantined and pending rather than falsely applying a missing result. Provider payloads/credentials are not logged. Other service failures and quota preserve their prior safe stop behavior.
- Actual bounded acceptance of that failing resource plus the next book: considered2, applied1, failed1, pending2325, stopped=complete with an explicit retry time. This proves continued work, not completed coverage.

## Evidence / test boundaries

- Python:99 executed,98 passed, one unavailable Windows symlink-privilege skip.
- Detached Windows services:39 Node tests passed, including secret-environment filtering and quota/timer/lifetime contracts.
- WPF/PowerShell: installed image-only Windows OCR quality, search/render/cancel, folder watcher, tray, explicit Exit and full child-tree cleanup passed. A separate SSD management-directory upgrade regression was observed RED then GREEN.
- Full web suite immediately before the final malformed-response patch:857 passed, four conditional skips. Web production build and typecheck passed at that point.
- Final patch:17 focused Logos/owner/retry tests passed; typecheck passed. The new malformed-response tests were first observed with two failures before implementation. A recovery case was already green and is not claimed as a newly failing regression.
- Actual legacy-overlay AND search and quoted-phrase search:40 matches each, all inspected result pages satisfy the clauses; page rendering and timeout cancellation passed. Visible native result highlighting also checked.
- GitHub Actions remains NOT_RUN because of the account allowance block. No repeated CI runs or billing changes were requested.
- Actual November11 iPhone/iPad acceptance and delivery of any pre-existing offline browser outbox are NOT_RUN. Existing browser/device caches were preserved; the earlier November1 offline/mobile confirmation is historical evidence only.

## Completion boundary and decisions

- Finish the final collector patch release and native restart; retain OCR/provider queues for background completion. Full OCR completion, all Logos covers, and manual review of40 PDF/six edition holds are not gates for this cutover.
- Use SSD state for responsive SQLite commits while keeping application/archives on the external working drive. Preserve the interrupted external-drive recovery copy separately; it is not completion evidence.
- Restrict remaining verification to changed behavior and final live lifecycle; do not repeat the unchanged full library scan, restore rehearsal or full browser suite.
- Minor deferred: native generic collector status does not expose every optional Logos startup error. Operator checkpoints remain the acceptance source. No idle database health polling is added.
- Archive recovery keys are currently protected for this Windows user. Recovery under a different Windows identity is NOT_RUN; no plaintext key was put in Git or chat.
