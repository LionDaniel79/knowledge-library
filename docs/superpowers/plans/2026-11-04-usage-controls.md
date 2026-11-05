# Usage controls implementation plan

> **For agentic workers:** Execute inline with superpowers:executing-plans. Preserve the existing PR stack and user data.

**Goal:** Remove duplicate CI runs and indefinite idle browser polling without removing validation or delaying explicit saves.

**Architecture:** Keep all CI steps, but run branch work on pull requests and main work on pushes; cancel superseded runs per PR. Bound automatic sync polling by recent user activity; foreground/online/manual/local-save paths retain their existing behavior.

**Tech Stack:** GitHub Actions YAML, React, Playwright with isolated in-memory fixtures.

**Spec:** User request to diagnose GitHub/Neon usage and complete safe remaining verification work (2026-11-04).

## Global constraints

- Do not modify original PDF/OCR/SQLite or existing production/QA business rows.
- No production deployment, PR merge, paid budget increase, or credential rotation.
- Keep existing tests and all explicit sync/save behavior.
- Reuse the clean isolated `fix/stage5-e2e-nov04` worktree; do not move other branches.

## Review focus

- Inactive foreground pages stop querying; returning interaction resumes.
- Reading by scrolling counts as activity; keyboard and pointer input count too.
- Offline/hidden pages never start periodic checks.
- A running sync is not interrupted by inactivity, navigation, or subsequent input.
- Manual sync and local-save remain immediate; PDF automatic-sync deferral remains intact.

## Task 1: Stop duplicate CI work

- [x] Change the three existing workflows to main-only push plus PR/manual triggers; retain existing relevant path filters and all job steps.
- [x] Add per-PR/ref concurrency cancellation and bounded job duration; skip documentation-only library checks and draft PR jobs. `ready_for_review` starts validation when a draft is ready.
- [x] Parse YAML, compare every job step with HEAD, and inspect push/PR/manual/draft event behavior. Remote execution remains blocked by the account allowance.

## Task 2: Stop indefinitely polling unused browser windows

- [x] Add a browser regression showing repeated checks stop after five minutes without interaction and resume on interaction/foreground/reconnection.
- [x] Run the test against current code and record the expected failure (an idle hour still invoked sync). A runtime call spy is necessary so in-flight HTTP coalescing cannot hide repeated timer calls.
- [x] Update ReplicaEntry's periodic resume gate; do not change runtime sync, outbox, or active requests.
- [x] Run affected browser regressions, typecheck, format, and build; use synthetic data and no real DB credentials. Full browser suite: 332 passed. Unit suite: 805 passed plus all 4 explicitly enabled conditional tests passed.

## Task 3: Consolidate remaining acceptance evidence

- [x] Summarize measured GitHub job duration separately from invoice totals and Neon compute separately from transfer.
- [x] Reconfirm PR stack, manifest preview evidence, and backup integrity without repeating full live downloads/transfers.
- Commit and push reviewed changes; record final SHA/remote status in the private verification report rather than making a second documentation-only push.
- [x] Report mobile/independent recovery-key verification and final merge/deploy gates accurately: these remain unverified or unapproved, not passed.

## Decisions

- No changes to Neon compute sizes: measured mean compute is close to the minimum, and the original idle suspension is enabled. Reducing the configured maximum would not address the measured repeated polling.
- No pg_stat_statements installation/reset in production: existing extension is unavailable, and business data/schema preservation takes precedence. Historical query attribution remains limited.
- No automatic retry of blocked GitHub jobs and no repeated full manifest uploads: previous local and HTTPS evidence is retained.
- No CI test steps were removed. Windows contract paths additionally include the server digest contract and its HTTP integration tests.
- The Python bundled with the coding runtime lacks the Windows OCR interop (`winrt`) package. Its initial OCR fixture failed; all 24 desktop/API tests and WPF smoke passed using the documented existing OCR virtual environment. No original OCR job was launched.
- Narrow independent review of all six files found no critical, important, or minor defects; it did not independently rerun the tests or inspect production data.
