# AI adoption latency

Diagnose with isolated real code paths, deterministic delayed API/browser fixtures and PGlite transaction fixtures; distinguish fixture timing from production/network measurements. No personal suggestions are applied for benchmarking.

1. Measure freshness validation query counts and remove only results discarded before the scope/version comparison. Retain target version checks, owner sync lock, transaction/revisions and adoption receipt replay. Add aggregate Server-Timing headers without identifiers or content.
2. Show per-suggestion pending feedback on click. Patch server-confirmed adoption into the request/detail state and existing relationship overlay rather than reloading the request list/detail. Keep retry possible on failure and guard duplicate clicks.
3. Merge canonical relationship events into visible board/box resources without requerying full resources or reloading home data; retain background sync for other devices. Preserve owner isolation and newer versions.
4. Test delayed and failed saves, repeat confirmation, all supported adoption kinds, query budgets, version conflicts, browser feedback and network counts. Run relevant tests, typecheck/build and independent review.
