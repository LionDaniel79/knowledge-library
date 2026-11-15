"use client";
import { useState } from "react";
import {
  AutoBibliographyPanel,
  type AutoBibliographyState,
} from "./auto-bibliography-panel";
import { CurationDetails } from "./curation-details";
import { catalogProviderNames } from "@/lib/book-lookup";
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
            automaticSource={
              a && (
                <article className="information-source">
                  <h4>자동 보완</h4>
                  <p>
                    {catalogProviderNames[
                      a.provider as keyof typeof catalogProviderNames
                    ] ?? a.provider}{" "}
                    · {new Date(a.appliedAt).toLocaleString("ko-KR")}
                  </p>
                  <p>{a.reason}</p>
                  <p>
                    {a.alternateEdition
                      ? "다른 판본의 정보를 참고해 보완"
                      : "동일 판본의 정보로 보완"}
                  </p>
                  {a.url && /^https:\/\//i.test(a.url) && (
                    <a href={a.url} target="_blank" rel="noreferrer">
                      자료 원문
                    </a>
                  )}
                </article>
              )
            }
          />
        </>
      )}
    </details>
  );
}
