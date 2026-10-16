import { LibraryApp } from "@/components/library-app";
import { previewLibrary } from "@/lib/preview-data";
export default function Preview() {
  return <LibraryApp initial={previewLibrary} today="2026-10-10" preview />;
}
