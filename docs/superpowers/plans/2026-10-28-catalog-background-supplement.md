# Catalog background supplementation implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement sequentially.

**Goal:** Save books promptly, supplement matching editions from both providers in the background, and resolve the existing review queue conservatively with stored covers.

**Architecture:** Existing book enrichment JSON carries durable queue state. A bounded PC collector fetches cached ISBN records outside transactions, then fills missing fields and saves evidence with sync locks and source checks. Review reconciliation reuses the same identity and supplement rules.

**Tech Stack:** TypeScript, Postgres, existing PGlite tests, SQLite quota/cache, Windows hidden scheduled worker.

**Spec:** docs/superpowers/specs/2026-10-28-catalog-background-supplement-design.md

## Global constraints
- No API keys in browser, logs or Git; use the PC's existing protected configuration.
- Preserve human edits, original PDFs, notes and reading cycles; exclude papers/periodicals.
- Store cover bytes, keep provenance internal, synchronize through existing owner locks.
- No schema migration, paid AI call or whole-library recurring download.

## Review focus
- Same ISBN with conflicting volumes/authors must remain unresolved.
- Book edits during collection must not be overwritten.
- Cache misses, quotas and temporary failures must retain retryable work.
- Separate owned copies sharing ISBN must remain separate.
- Reviewed/hidden curation and deliberately removed covers must not reappear.

### Task 1: Durable queue and provider combination
- [ ] Add failing tests for enqueue, both-provider collection, cache reuse and partial failures.
- [ ] Implement queue creation on add/identity edits and verified PDF identification.
- [ ] Implement bounded PC collector with persistent cache, backoff and safe supplementation.
- [ ] Verify and document hidden automatic startup for this PC and portable installation.

### Task 2: ISBN-safe candidate reconciliation
- [ ] Add failing tests for compatible/missing fields, conflicting editions, priority covers, duplicate alternatives and repeat runs.
- [ ] Implement candidate ranking, stored covers and audit-preserving decisions.
- [ ] Audit live counts, reconcile approved matches, mirror missing known covers; retain minimal ambiguity list.
- [ ] Verify unchanged note/cycle fingerprints and report resulting counts.

### Task 3: Release
- [ ] Run targeted tests, typecheck, production build and private-artifact verification.
- [ ] Review the completed diff and deploy public/private runtimes without stopping OCR.
- [ ] Verify a queued test flow, remove only disposable fixtures, and report actual completed/remaining work.
