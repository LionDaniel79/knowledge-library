"use client";
import { useEffect, useState } from "react";
import type { Book } from "@/lib/domain";
import { useReplicaOptional } from "./replica/provider";
import { useReplicaImage } from "./replica/use-image";
const colors = ["sage", "clay", "night", "sand", "moss", "wine"];
export function BookCover({
  book,
  small = false,
}: {
  book: Book;
  small?: boolean;
}) {
  const replica = useReplicaOptional();
  const [failed, setFailed] = useState<string[]>([]);
  const pdfId =
    book.sourceData?.app === "Local PDF" ? book.sourceData.recordId : undefined;
  useEffect(
    () => setFailed([]),
    [
      book.id,
      book.coverUrl,
      book.storedCoverUrl,
      book.storedImportedCoverUrl,
      book.catalogCoverUrl,
      book.sourceData?.cover?.sha256,
      pdfId,
      replica?.revision,
    ],
  );
  const sources = [
    { src: book.storedCoverUrl },
    {
      src: book.coverUrl?.startsWith("/api/book-covers/")
        ? book.coverUrl
        : undefined,
    },
    {
      src: book.storedImportedCoverUrl,
    },
    {
      src: book.sourceData?.cover
        ? "/api/import-assets/book/" + book.id
        : undefined,
    },
    { src: book.catalogCoverUrl },
    {
      src: pdfId ? "/api/pdf/" + pdfId + "/cover" : undefined,
      title: "PDF 첫 페이지 미리보기",
    },
  ];
  const selected = sources.find(
    (source) =>
      source.src &&
      !failed.includes(source.src) &&
      (!replica?.ready ||
        source.src.startsWith("/api/book-covers/") ||
        (source.src.startsWith("/api/pdf/") && navigator.onLine)),
  );
  const assetId = selected?.src?.match(
    /^\/api\/book-covers\/([a-f0-9-]{36})$/i,
  )?.[1];
  const localImage = useReplicaImage(assetId);
  useEffect(() => {
    if (localImage.error && selected?.src)
      setFailed((previous) =>
        previous.includes(selected.src!)
          ? previous
          : [...previous, selected.src!],
      );
  }, [localImage.error, selected?.src]);
  const src = localImage.local && assetId ? localImage.url : selected?.src;
  if (selected && src)
    return (
      <div
        className={"book-cover imported-cover" + (small ? " small" : "")}
        aria-hidden="true"
      >
        <img
          src={src}
          title={selected.title}
          referrerPolicy="no-referrer"
          alt=""
          loading="lazy"
          onError={() => setFailed((previous) => [...previous, selected.src!])}
        />
      </div>
    );
  const color =
    colors[
      Array.from(book.title).reduce((a, c) => a + c.charCodeAt(0), 0) %
        colors.length
    ];
  return (
    <div
      className={"book-cover " + color + (small ? " small" : "")}
      aria-hidden="true"
    >
      <span className="cover-category">{book.tags[0] || "MY LIBRARY"}</span>
      <strong>{book.title}</strong>
      <span className="cover-line" />
      <span className="cover-author">{book.author || "나의 서재"}</span>
    </div>
  );
}
