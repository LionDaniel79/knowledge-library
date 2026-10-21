# OCR Quality Implementation Plan

> Execute inline with superpowers:executing-plans. TDD for each behavior; one final independent review.

**Goal:** Preserve source and prior OCR while preparing better body/footnote OCR and resumable local-only batch reprocessing.
**Architecture:** Existing Windows OCR + high-resolution tiled processing, a local candidate job store beside the PDF index, owner-authenticated local-only API and compact controls in PDF folder settings. OCR storage never uses Neon.
**Tech Stack:** Python 3.13, Pillow, pypdfium2, Windows.Media.Ocr; Node24/SQLite; existing Next/React.
**Spec:** ../specs/2026-10-22-ocr-quality-design.md

## Global constraints

- Original PDFs/native extracted text/user writing stay unchanged.
- No local LLM, no paid OCR/API calls, no production DB reads while quota exhausted.
- Actual library unavailable until external disk reconnects; implement/test now, validate real accuracy and execute bulk later.

## Task 1: quality processing

- Write failing Python tests for 300dpi tiles, position mapping/overlap dedupe, repeated edge lines vs footnotes, suspicious content and deskew.
- Implement scripts/pdf_ocr_quality.py and backward-compatible coordinate output in windows_ocr.py. Keep the current worker unchanged by default.
- Expected: image/layout tests pass; synthetic quality is not proof of real-book accuracy.

## Task 2: local rerun jobs

- Write failing SQLite tests for native/excluded-page protection, old-result preservation, resume, stale-content/owner rejection, apply and restore.
- Implement scripts/pdf_reocr_store.py and scripts/pdf_reocr.py with source validation, existing disk lock, bounded page processing and explicit result application.
- Expected: state-machine and source-integrity tests pass without Neon.

## Task 3: app control and usage guide

- Add owner/origin/cloud guards and local child-process control without DATABASE_URL in the worker environment.
- Add compact sample/batch/pause/resume/review/apply controls under PDF folder settings; detailed help collapsed.
- Document optional offline CLI and Neon quota facts/options. No plan upgrades or migrations.
- Expected: API security and desktop/mobile synthetic E2E pass.

## Task 4: verification and review

- Run Python, unit/typecheck/E2E/build/privacy checks and one fresh review; fix important findings with regression tests.
- Prepare code/release while external disk is absent. Explicitly retain actual-book quality validation and actual batch execution as pending external input.

## Review focus

- Source/old text changes between generation and application cannot be overwritten.
- Cropping must preserve footnotes, chapter titles, one-off marginal content and two-column order.
- Rotation and coordinates must refer to the same transformed image.
- Existing OCR/import writers must not race result application.
- Local processing must never silently query Neon or bypass account authentication.
