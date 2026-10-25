"use client";
import { useEffect, useState } from "react";
import type { Library } from "@/lib/domain";
import { AdvancedSearch } from "./advanced-search";
import { IntegratedSearch, type SearchCards } from "./integrated-search";
const empty: Library = { books: [], notes: [], cycles: [] };
const tabs = { book: "도서 검색", note: "메모 검색", all: "통합 검색" };
export function LibrarySearchPanel({
  onOpen,
  library = empty,
  ownerId = "default",
  preview = false,
  onUpdated = async () => {},
  renderBook,
  renderNote,
}: {
  onOpen: (kind: string, id: string) => void;
  library?: Library;
  ownerId?: string;
  preview?: boolean;
  onUpdated?: () => Promise<void>;
} & SearchCards) {
  const [tab, setTab] = useState<keyof typeof tabs>("book");
  const key = "library:search-tab:" + ownerId;
  useEffect(() => {
    try {
      const saved = localStorage.getItem(key);
      setTab(saved === "note" || saved === "all" ? saved : "book");
    } catch {
      setTab("book");
    }
  }, [key]);
  return (
    <section className="panel library-search-panel">
      <div
        className="library-search-tabs"
        role="tablist"
        aria-label="검색 방식"
      >
        {Object.entries(tabs).map(([id, name]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={"search-tab-" + id}
            aria-controls={"search-panel-" + id}
            aria-selected={tab === id}
            className={tab === id ? "primary" : "secondary"}
            onClick={() => {
              setTab(id as keyof typeof tabs);
              try {
                localStorage.setItem(key, id);
              } catch {}
            }}
          >
            {name}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={"search-panel-" + tab}
        aria-labelledby={"search-tab-" + tab}
      >
        {tab === "all" ? (
          <IntegratedSearch
            library={library}
            onOpen={onOpen}
            renderBook={renderBook}
            renderNote={renderNote}
          />
        ) : (
          <AdvancedSearch
            key={tab}
            mode={tab}
            library={library}
            onOpen={onOpen}
            preview={preview}
            onUpdated={onUpdated}
          />
        )}
      </div>
    </section>
  );
}
