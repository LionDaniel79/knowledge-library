# Record editor and whiteboard controls

**Goal:** Stable record editing with a scrolling heading, inline topic creation and explicit multiple-tag application; clear whiteboard multiple selection and compact layout.

**Approach:** Reuse the existing topic command, note form, whiteboard layout function and undo/save flow. Tags for record creation/editing use a controlled list below the field instead of the browser datalist. Search filters retain their existing meaning; whiteboard facets allow multiple selections until the existing Search action is pressed.

- [x] Browser regression tests for scrolling headings, editor geometry, topic create/select/duplicate/error, tag draft/apply/cancel/new tags and record save payload.
- [x] Stabilize memo viewport and background record refreshes without clearing saved form inputs or hiding errors.
- [x] Add topic creation to the shared note topic field and replace note tag datalist with an inline checkbox picker and Apply.
- [x] Add whiteboard Arrange beside Show all, using existing layout, persistence and undo; make multi-selection explicit for all four facets.
- [ ] Verify layout preservation, connections, desktop/touch actions, typecheck and build; review and deploy without interrupting OCR.

Review correction: keep record save/delete/dismissal locked until an in-flight topic creation has updated the selected topic IDs; keep text fields editable. Safari tag Escape uses the dialog's native cancellation event so it closes only the tag list. Record tags are serialized from the controlled array to preserve literal names.
