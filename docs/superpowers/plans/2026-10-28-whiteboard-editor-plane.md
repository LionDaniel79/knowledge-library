# Whiteboard note editing and free coordinates

The requested behavior is fully specified: keep fullscreen while opening a note,
halve the note dialog's width and height, retain the field order and columns with
vertical scrolling, and allow notes/groups to move in every direction.

1. Reproduce fullscreen exit, normal-size editor and coordinate snapping in the
   real browser fixture; cover signed coordinates in domain and store tests.
2. Open shared native dialogs within the active fullscreen board. Keep keyboard
   dismissal and focus restoration, and scope compact form styles to that board.
3. Remove coordinate range clamps in drag, board validation and group geometry.
   Keep finite-number, payload size, ownership and optimistic-version validation.
   Place a newly formed stack's heading inside the current viewport without
   changing the camera or limiting where the finished stack can be moved.
4. Verify editing/scrolling/closing in native and fallback fullscreen, signed drag
   and save/reload, connections and existing editor controls, then run the full
   unit suite, typecheck and production build.
5. Deploy the same commit to the public app and private PC runtime, retaining all
   OCR workers. No personal notes or existing board layouts are changed by tests.
