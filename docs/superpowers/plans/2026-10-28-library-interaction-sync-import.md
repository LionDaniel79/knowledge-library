# Library interaction, sync review and PDF import repairs

- [ ] Persist the last knowledge tab and memo-box subtab on this device per owner;
      explicit tag navigation still opens records. Verify remount and owner isolation.
- [ ] Pass a whiteboard note's screen rectangle to its editor. Use the compact
      editor size in normal and fullscreen boards, prefer the right/left of the
      note, and constrain the dialog to the viewport without changing the camera.
- [ ] Reproduce archived-topic assignment failures against SQL. Show the archived
      topic clearly and require an explicit restore-and-apply choice, then replay
      restoration before the reviewed assignment. Preserve original commands and
      support keeping the online state without restoring or deleting any note.
- [ ] Reproduce the empty PDF-import response. Keep scans in the background,
      bound client waits, recover an accepted job when its response was lost, and
      return readable failures for empty/non-JSON responses. Verify first and later
      folder scans, exclusions, worker startup and runtime packaging.
- [ ] Run targeted failures before fixes, related suites, typecheck, production
      build and artifact checks; deploy public and private releases. Preserve OCR
      workers and all personal conflict choices. Record any remaining limitations.
