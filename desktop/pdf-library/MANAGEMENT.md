# Standalone library engine

`management.py` is the standalone library engine behind the `library-*` worker
actions. It starts no HTTP listener and does not depend on the former PDF server.
Choose a private state directory outside the PDF library. The only writable
SQLite is `management-v1.sqlite` (application ID 843028, schema version 2;
version 1 is upgraded transactionally while retaining IDs/pages/queue).
Never point this directory at the legacy index, synced project sources, or the
original PDFs. Existing `reader.py`, `registry.py`, their SQLite files, and original
PDFs are not migrated or modified.

## Worker interface

All functions return JSON-compatible objects. `directory` is required. `index`
is optional; an empty value supports a first-time user with no old index.

| Function | Arguments beyond `directory` | Result |
| --- | --- | --- |
| `scan` | `root`, `index=None` | `run`, `files`, `hashed`, `state='complete'` |
| `status` | `limit=100` (`None` for all) | `resources`, `availableCopies`, `totalPages`, `completedPages`, `queue`, `paused`, `documents`, `documentsTruncated`, `scan`, `current`, `webPending`, `webHeld` |
| `ocr_step` | `index=None` | One page result: `state`, and when selected, `document`, `title`, `page`; sanitized `error` on failure |
| `pause` | `paused=True` (boolean) | `paused` |
| `retry` | `document=None` | `retried` error-page count |
| `search` | `query`, `kind=''`, `document=''`, `index=None`, `seconds=10` | Existing reader-compatible `hits`, `terms` |
| `render` | `document`, `page` (1-based integer), `index=None` | `page`, `total`, base64 PNG `image` |
| `audit` | none | Local-only `locations`, `physical`, `available`, `registrationCopies` |
| `prepare_web` | none | `requests`: durable batches for `/api/desktop/library` |
| `pending_web` | none | `requests`: unchanged pending bodies |
| `apply_web_result` | `request_id`, `result` | `requestId`, `applied` |
| `sync_web` | `origin`, `token` | `applied`, `pending`; `state='offline'` or `'changed'` when locations cannot be sent |

The existing worker accepts these under `library-scan`, `library-status`,
`library-ocr-step`, etc. UI code should periodically call scan to discover added
files and repeatedly call OCR step while pending connected work remains.
`ocr_step` returns `done`, `error`, `paused`, `idle`, or `offline`; do not busy-loop
on the latter three. `retry` explicitly requeues failed pages. Pause is durable.
A process interrupted on a page resumes it on the next step; already committed
pages and their FTS entries remain. Native OCR runs in the disposable worker
process, so the existing Windows job cancellation also stops native recognition.

`status.queue` has `pending`, `running`, `done`, `error` counts. Its document rows
include `id`, `resourceId`, `title`, `kind`, `totalPages`, `available`, `copies`,
per-document queue counts, `errors` (page/error/attempts), `error`, and `webState`.
`current` contains the running resource/page/title, and `scan` contains the most recent
run state and counts. `completedPages` includes usable pages reused from the old
index. A zero-page initialization task represents a PDF that could not be opened;
retry reopens it before creating page work. Invalid PDFs are inventoried and
reported instead of preventing the rest of the library from being scanned.

Progress polling caps document details at 100 by default (up to 1000, or explicit
`None` for all). The counts remain global and `documentsTruncated` reports the
cap. Global `availableCopies` uses the last verified scan and checks that each
root/volume is still connected; displayed documents revalidate current file
signatures. `audit` performs the exhaustive physical check. This avoids statting
an entire external library every few seconds. `webHeld` counts excluded,
conflicted, and ambiguous legacy resources; document rows also provide
`legacyDocumentIds` and `webIssue` when an old identity needs review.

Document rows also expose `author`, `publisher`, and normalized `isbn`. An initial
scan reads PDF Info fields and at most the first two embedded-text pages for
bibliography. Known legacy author/publisher/ISBN metadata and existing front-page
OCR can fill missing values without altering the old index. After recognition,
only pages 1–20 can supply a missing ISBN. ISBN-10/13 checksums match the existing
web bibliography helper, ISBN-10 is normalized to ISBN-13, and ambiguous or
reference-list candidates are withheld. Known ISBNs are never overwritten.
Finding a new ISBN changes the ordinary safe metadata fingerprint and creates
a CAS registration delta for the server's existing ISBN collector. No original
page text or ISBN evidence quote is transmitted and no title/ISBN merge is made.

For graceful cancellation, scan, OCR step, and sync also accept an in-process
`stop()` callback. Scan accepts `progress(files, hashed)` per file. Tests may
inject `recognize(path, page) -> (text, method)` and `send(payload) -> response`;
normal worker JSON must never expose these callables as configurable code.

## Identity, scope and preservation

The first scan hashes every PDF and later scans reuse unchanged file signatures
(size, mtime, ctime, inode, volume); additions, moves, and replacements are hashed.
A local SHA-256 maps to a random stable resource UUID. SHA-256 stays local.
Identical copies share OCR and maintain all physical locations. A completed
second enumeration is required before absent paths become missing. Failed walks,
unplugged roots and partial/cancelled scans never authorize missing state or a new
web snapshot. Availability always checks the current physical file signature.

All folders under the selected library root are searchable and eligible for local
OCR, including papers and periodicals. Only exact first-level `기독도서` and
`일반도서` folders and their descendants can produce web locations. Both selected
folders must be connected and the last scan complete before transmission.

When supplied, the legacy SQLite snapshot is opened through `reader.source` with
`mode=ro&immutable=1`, `query_only`, and before/after file stamps. Live WAL/journal
indexes are rejected. Known content hashes reuse legacy document UUIDs and valid
page text; a legacy row without a hash may bind only at its unchanged exact path,
size and mtime. Hashless relocations are not guessed. Old page text remains in the
old index; newly recognized pages and their FTS entries live in the new database.
Moving a verified copy retains aliases, search citations, and page rendering.
Newly managed page text takes precedence over an old page.

Several distinct legacy document UUIDs may point at identical PDF bytes. Their
aliases are retained, legacy search returns their original IDs, and automatic web
registration is held rather than arbitrarily choosing an existing book. Searches
accept either a resource UUID or a known old/server document UUID.

Default recognition reuses `sandbox.candidate`, which reads embedded PDF text
with PDFium and otherwise uses `scripts/pdf_ocr_pipeline.CachedRenderer` and
`scripts/pdf_ocr_languages.AdaptiveWindowsOcr`. No original PDF/OCR/index is written.

## Outbound web queue

`prepare_web` emits at most 100 resources per immutable batch and keeps its UTF-8
body below the server's 1 MiB limit, each identified by
a durable request UUID. It sends only resource/book/document UUIDs, CAS book
versions, bounded bibliography, and approved root keys with relative paths. It
never sends local absolute paths, content hashes, PDF bytes or OCR text.
Bibliographic titles are normalized and bounded to the API's 300-character limit.
Paths reject traversal, drive/UNC names, controls, reserved Windows device names,
unsafe punctuation and trailing dots/spaces; a path that cannot meet the server
contract is omitted from registration while remaining managed locally. Resources
with more than 32 approved locations are held for location review.

`sync_web` uses outbound HTTPS with standard certificate checks and a fixed API
path, without redirects. Tokens are passed via worker stdin and retained only in
memory. Initial legacy links first fetch owner-scoped IDs/current CAS versions
from `/api/desktop/catalog/versions`; the registration API still performs the
authoritative ownership, exclusion and version checks. Offline/failed requests
retain exactly the same UUID/body for retry. A newly completed scan supersedes
queued location bodies that are no longer current, creating new request UUIDs;
stable device/resource IDs protect the server mapping even if an old request was
delivered before a lost response. Every batch is rechecked locally before send.

Acknowledgements are fully validated before one local transaction writes any
mapping. Registered/unchanged require valid IDs and positive versions. Excluded
and conflict allow null identities, remain visible in `webState`, and are never
automatically reimported. Network/native error details are replaced with safe
messages so credentials or absolute paths cannot leak from exception strings.
`audit` is explicitly local-only and includes absolute physical paths alongside
the eligible root key/relative path and the last scan confirmation timestamp.

## Isolated verification

```powershell
Set-Location C:/Users/admin/kl-stage5-e2e-1104/desktop/pdf-library
& 'E:/지식서재 작업/private-data/runtime/ocr-quality-20261022/Scripts/python.exe' -m unittest test_management -v
```

Fixtures create small PDFs and a legacy SQLite only under a temporary directory.
Tests inject OCR/transport; they perform no live API calls, operating-library
scans, real OCR, credential reads, or original database mutations.
