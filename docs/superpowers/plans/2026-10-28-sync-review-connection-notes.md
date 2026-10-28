# Sync review and connection note disclosure

1. Reproduce keeping a new note, topic and whiteboard when no downloaded server
   row exists. Preserve explicit user choices and missing/deleted-record guards.
2. Load the full ordered edit chain even when a later entry is opened. For an
   unsent creation, rebuild its commands against downloaded state and earlier
   pending changes. Preserve chronology and remap structured context identities
   and dependencies, while retaining original commands in the resolution archive.
3. Verify the whole reviewed note/topic/edit sequence against an isolated SQL
   database, including successful push/pull and an empty conflict/outbox queue.
4. Within whiteboard connection details, show each pair's note disclosures inside
   its connection disclosure. Keep the memo-box reading layout unchanged.
5. Run regressions, unit/browser suites, typecheck/build and private-artifact
   checks, then deploy the same revision to public and private runtimes. Existing
   personal conflict choices are left for the user; OCR workers stay running.
