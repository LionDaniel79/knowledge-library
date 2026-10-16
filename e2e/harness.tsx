// Browser-test entry only. Never mounted by a Next.js route.
import { createRoot } from "react-dom/client";
import { LibraryApp } from "../src/components/library-app";
import { previewLibrary } from "../src/lib/preview-data";
createRoot(document.getElementById("root")!).render(
  <LibraryApp initial={previewLibrary} today="2026-10-10" />,
);
