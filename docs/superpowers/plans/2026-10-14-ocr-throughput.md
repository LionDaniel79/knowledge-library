# OCR Throughput Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans, directly and sequentially as authorized by the user.

**Goal:** Preserve OCR quality and provenance while reducing file churn and running two OCR engines with bounded memory.
**Architecture:** Cache one PdfDocument on the main thread, send in-memory lossless PNG to independent Windows OCR processes, and serialize validated commits. A shared disk lock prevents OCR/hash contention; PID-scoped stop requests allow checkpointed restarts.
**Tech Stack:** Python, PDFium, Pillow, WinRT Windows OCR, SQLite, unittest.
**Spec:** docs/superpowers/specs/2026-10-14-ocr-throughput-design.md

## Global Constraints
- E:/전자도서관 originals are read-only; all large work and benchmark artifacts stay on E. No local LLM, provider calls, cloud changes, push or deployment.
- Preserve the existing scale=min(3,2500/max(page.get_size())) and RGB pixels; lossless PNG compression may change the image hash but not recognized pixels.
- At most two OCR requests in flight; PDFium only on the main thread; one database writer and per-page commit. Keep existing exclusion, signature and 8GiB disk guards.
- Keep the existing feature checkout; no package reinstall or new model download. No AI-folder deletion retry.

## Review Focus
- A file or processing scope changes after rendering while results are in flight: no stale text/error audit may be committed.
- An OCR process exits or times out: stop and leave unprocessed pages resumable; no mass error marking.
- Results complete out of order: correct document/page/hash mapping and bounded work are preserved.
- Disk becomes low or stop is requested with two requests queued: stop safely and retain committed progress.
- Metadata-only documents or existing native/OCR text: never enter the default pipeline or get overwritten.

### Task 1: Memory rendering and OCR transport
**Files:** scripts/pdf_ocr_pipeline.py (new), scripts/pdf_ocr.py, scripts/windows_ocr.py, scripts/test_pdf_ocr_pipeline.py (new).
**Interfaces:** CachedRenderer.render(row) -> {png:bytes,width:int,height:int}; close(). WindowsOcr.recognize_png(png:bytes) -> OCR result. WindowsOcr.__call__(path) remains compatible. Fatal engine failures use OcrEngineError.
- [x] Test cache reuse/closure, pixel identity, memory transport parity, bounded payload and engine failure before implementation; run and observe RED.
- [x] Implement cache and memory bridge without changing engine/language/resolution; run targeted tests GREEN.
- [x] Commit task and record results.

### Task 2: Bounded parallel coordinator and disk scheduling
**Files:** scripts/pdf_ocr.py, scripts/pdf_job_state.py, scripts/pdf_maintenance.py, scripts/test_pdf_ocr.py, scripts/test_pdf_ocr_pipeline.py.
**Interfaces:** ocr_work accepts a recognizer or list of 1–2 recognizers and should_stop callback. CLI --workers {1,2} defaults to 2; --stop requests a PID-bound stop. processing_lock(index,kind) acquires common disk lock plus worker-kind lock. png work is memory-only when recognizer supports recognize_png, legacy path callbacks use isolated external temp files.
- [x] Add regressions for concurrent recognition/ordered evidence, limit and stop drain, retry/native/excluded preservation, changed source/scope/error protection, fatal-engine interruption and common-lock contention; observe RED.
- [x] Implement scheduler with bounded futures, book-local rendering, sequential guarded writes and durable status. Optimize book counts incrementally rather than rescanning all page text per result; verify correction on resume.
- [x] Run all Python tests and project unit tests; Expected: all pass. Commit.

### Task 3: Real benchmark and operational restart
**Files:** scripts/benchmark_pdf_ocr.py (new), docs/pdf-operations.md, private E benchmark reports.
**Interfaces:** small independent benchmark DBs reference fixed source pages; compare legacy baseline, memory single engine and memory two engines with text hashes and source signatures. Never alter production index during benchmark.
- [x] Prepare same-page benchmark with private reports on E; check sampling/fixture isolation and quality comparisons.
- [x] Stop legacy processes with exact PID/script identity after saving progress; source originals are untouched and SQLite per-page commits are retained. If remaining hash work finishes first, no hash restart is needed; otherwise resume it separately after the sample/short OCR batch.
- [x] Measure end-to-end and quality parity. Apply the faster verified mode; no promised multiplier. Run fresh whole-change review, fix Important findings with RED→GREEN, full appropriate tests.
- [x] Resume real OCR under new coordinator, verify advancing saved progress and single active coordinator. Document measured limits and keep branch local.
