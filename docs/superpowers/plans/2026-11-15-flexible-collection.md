# Flexible desktop collection

User requests unscheduled background collection, roomier limits and editable schedules if needed. Reuse WPF, host, finite collectors and existing ledgers.

- [ ] Settings: mode continuous/scheduled/manual, editable Korean HH:mm times (1–8), daily 0–10000 and per-run 1–10000. Existing settings default to scheduled and preserve old limits. Provider budgets unchanged; internal batches stay <=100.
- [ ] Timing: continuous respects remaining daily reservations, alternates collectors, waits one hour after empty work and 15 minutes after a deferred sequence. Scheduled runs latest due user time once/day; legacy time sessions preserved. Manual requests remain one-shot.
- [ ] Runner: per-run ceiling, re-read settings between chunks, stop if automatic mode changes, preserve day boundary and cache audits. Persist cooldown for interrupted/deferred sequences to avoid loops.
- [ ] WPF: mode, daily, run limit and times saved together; preserve unsaved edits during refresh; show active mode/times. Test settings, schedules, continuous fairness/no-work cooldown, pause/limit and synthetic native UI.
- [ ] Install at safe idle OCR/collection boundary, preserve settings/cache/history; enable continuous with explicit 1000/day, 100/run per collector, no new scheduler. Verify host, document settings and API protections.
