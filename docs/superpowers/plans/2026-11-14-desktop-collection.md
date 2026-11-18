# Windows collection integration

User approved the existing WPF/tray approach and separate PDF/Logos collection menus, adding editable daily investigation limits. No HTTP server. Reuse finite TypeScript collectors, DPAPI runtime profile, API ledger, cache and checkpoints.

- [ ] Add a portable bounded controller using the existing stage12 ledger and lock. Settings accept 0–600 Logos / 0–500 PDF investigations/day; zero pauses that collector. Per-pass maximum remains 100. Limits changed during a pass take effect before the next pass; reservations prevent crash overrun. No automatic stage promotion overrides user settings.
- [ ] Add a tray host with one shared lock, morning/evening Logos and afternoon PDF scheduling, manual requests and pause between passes. Keep any existing global halt; never silently clear it.
- [ ] Separate WPF search/OCR, PDF collection and Logos collection tabs; expose daily settings, state, aggregate results and safe errors. Keep background work alive on window close.
- [ ] Test limits, partial batches, restart/reservations, pause, duplicate work, scheduling and synthetic host operation. Build WPF and test isolated UI. Install without replacing data; disable legacy tasks only after host validation and preserve task XML for reversal.

Known operational issue: existing global halt records a TypeError without enough diagnostic context. This integration must display it and must not bypass it to resume live writes. Resolve only if evidence identifies the cause; otherwise report separately.
