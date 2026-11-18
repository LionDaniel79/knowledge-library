"use client";
import { useState } from "react";
import {
  AutoBibliographyPanel,
  type AutoBibliographyState,
} from "./auto-bibliography-panel";
import { CurationDetails } from "./curation-details";
export function UnifiedBookInformation({
  bookId,
  onChanged,
}: {
  bookId: string;
  onChanged: () => Promise<void>;
}) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [opened, setOpened] = useState(false);
  const [automatic, setAutomatic] = useState<AutoBibliographyState | null>(
    null,
  );
  const a = automatic?.application;
  return (
    <details
      className="curation-details unified-book-information"
      onToggle={(event) => {
        if (event.target === event.currentTarget && event.currentTarget.open)
          setOpened(true);
      }}
    >
      <summary>자동 보완 내역</summary>
      {opened && (
        <>
          <AutoBibliographyPanel
            bookId={bookId}
            onChanged={onChanged}
            embedded
            refreshKey={refreshKey}
            onState={setAutomatic}
          />
          <CurationDetails
            kind="book"
            id={bookId}
            onChanged={async () => {
              setRefreshKey((value) => value + 1);
              await onChanged();
            }}
            embedded
            automatic={a}
          />
        </>
      )}
    </details>
  );
}
