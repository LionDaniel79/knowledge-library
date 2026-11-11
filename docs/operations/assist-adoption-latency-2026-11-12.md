# AI adoption latency

## Findings and scoped changes

Server source validation read every selected note twice and fetched up to100 connections/40 bundles whose values were immediately discarded before freshness hashing. Reuse the same locked current-record content/version/event and omit only unused target lists during validation. Target version checks, owner lock, transaction, revisions and idempotent receipt remain unchanged.

The UI acknowledged a save, then reloaded both request list and detail. Stale responses could leave the button apparently unconfirmed. Board listeners additionally invalidated their whole resource, and the record browser refreshed its parent library. Canonical adoption responses now patch request/card state and the owner-scoped relationship overlay directly. No adoption-specific list/detail/board refetch is necessary. Background device synchronization continues without holding the save acknowledgement; its progress no longer reloads settled AI history on every revision. Active requests retain their polling/manual refresh.

Buttons show pending immediately, reject double-clicks and show saved only after a successful response. Writing delegates are awaited and false/rejected results remain retryable. Older canonical retries cannot replace newer overlay versions; events from other owners are ignored.

## Before/after measurements

These are actual code-path executions with synthetic data, not live production latency measurements. No personal AI suggestion was confirmed for benchmarking. PGlite wraps each SQL query in a requested5ms delay (Windows timers/SQL add overhead); comparison uses the same fixture/conditions.

| Note-connection adoption | SQL before→after | Transaction before→after |
| --- | --- | --- |
|2 selected notes|16→12|253→180ms|
|20 selected notes|70→48|1087→758ms|

Connection title, thought bundle and bundle title fixtures also remove N+2 queries from N-source validation. The first transaction and retry both preserve a single adoption/revision. Changed source/event/target, trash and owner tests reject safely.

Browser tests hold the API response for500ms and deliberately return stale follow-up snapshots. Before: no pending label,2 extra AI GETs, saved button not confirmed within400ms after release. After: pending about2ms after click, saved about5–8ms after response release,0 extra AI GETs. Release-to-paint excludes real network variability; API fixture latency is intentionally fixed. A canonical board event updates visible relationships with0 extra resource reads. A blocked device sync does not hold acknowledgement.

Production successful adoption responses now expose aggregate Server-Timing handler/adopt/db_tx/db_sql/db_queries, without identifiers, SQL text or content. Handler minus adoption includes authentication/body/dispatch overhead; transaction includes lock/commit wait. No timing headers expose secrets. Actual production cold-start, authentication/network, lock contention and real multi-device propagation were not benchmarked.

## Verification

54 related unit tests passed;20 browser tests passed, including failed/repeated adoption, stale reads, delayed saves, writing-delegate failures, owner isolation and board patching. Typecheck and production build passed. Original DB records/PDF/OCR/SQLite were not modified. Real phone/tablet hardware verification and remote allowance-blocked CI are not claimed.
