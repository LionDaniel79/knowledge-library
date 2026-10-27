"use client";
import { useCallback, useEffect, useState } from "react";
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
  const pdfId =
    book.sourceData?.app === "Local PDF" ? book.sourceData.recordId : undefined;
  const failureKey = JSON.stringify([
    book.id,
    book.coverUrl,
    book.storedCoverUrl,
    book.storedImportedCoverUrl,
    book.catalogCoverUrl,
    book.sourceData?.cover?.sha256,
    pdfId,
    replica?.revision,
  ]);
  const [failure, setFailure] = useState({ key: "", urls: [] as string[] });
  const failed = failure.key === failureKey ? failure.urls : [];
  const markFailed = useCallback(
    (url: string) => {
      setFailure((previous) => {
        const urls = previous.key === failureKey ? previous.urls : [];
        return urls.includes(url)
          ? previous
          : { key: failureKey, urls: [...urls, url] };
      });
    },
    [failureKey],
  );
  const sources = [
    { src: book.storedCoverUrl },
    {
      src: book.coverUrl?.startsWith("/api/book-covers/")
        ? book.coverUrl
        : undefined,
    },
    {
      // Older imports/review decisions can contain an image address before its
      // stored copy exists. Resolve it through the owner-checked server route.
      src:
        !book.storedCoverUrl && book.coverUrl?.startsWith("https://")
          ? "/api/books/" + book.id + "/cover"
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
        (source.src.startsWith("/api/books/") && navigator.onLine) ||
        (source.src.startsWith("/api/pdf/") && navigator.onLine)),
  );
  const assetId = selected?.src?.match(
    /^\/api\/book-covers\/([a-f0-9-]{36})$/i,
  )?.[1];
  const localImage = useReplicaImage(assetId);
  const localFailed =
    localImage.error || (!!localImage.url && failed.includes(localImage.url));
  useEffect(() => {
    if (localFailed && selected?.src && !navigator.onLine)
      markFailed(selected.src);
  }, [localFailed, selected?.src, markFailed]);
  const src =
    localImage.local && assetId
      ? localFailed
        ? navigator.onLine
          ? selected?.src
          : undefined
        : localImage.url
      : selected?.src;
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
          onError={() => markFailed(src)}
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
