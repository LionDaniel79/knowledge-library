"use client";
import { useEffect, useRef, useState } from "react";
export function CoverInput({
  value,
  onChange,
  preview,
  onBusy,
  focus = false,
  previewUrl,
}: {
  value: string;
  onChange: (v: string) => void;
  preview: boolean;
  onBusy: (v: boolean) => void;
  focus?: boolean;
  previewUrl?: string;
}) {
  const field = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    if (focus) {
      const frame = requestAnimationFrame(() => {
        field.current?.scrollIntoView({ block: "center" });
        field.current
          ?.querySelector<HTMLInputElement>('input[type="radio"]')
          ?.focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [focus]);
  const [mode, setMode] = useState(
      focus || value.startsWith("/api/") ? "file" : "url",
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function upload(file?: File) {
    if (!file) return;
    setError("");
    if (preview) {
      setError("내 서재에서 표지를 추가할 수 있습니다.");
      return;
    }
    setBusy(true);
    onBusy(true);
    let bitmap: ImageBitmap | undefined;
    try {
      if (
        !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
        file.size > 8 * 1024 * 1024
      )
        throw Error("8MB 이하 JPG·PNG·WebP를 선택해 주세요.");
      bitmap = await createImageBitmap(file);
      if (bitmap.width * bitmap.height > 24000000)
        throw Error("이미지 해상도를 줄여 주세요.");
      const scale = Math.min(1, 800 / bitmap.width, 1200 / bitmap.height),
        canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas
        .getContext("2d")!
        .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const body = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(Error("이미지 변환 실패"))),
          "image/webp",
          0.82,
        ),
      );
      const r = await fetch("/api/book-covers", {
          method: "POST",
          headers: { "Content-Type": body.type },
          body,
        }),
        data = await r.json();
      if (!r.ok) throw Error(data.error);
      onChange(data.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "표지 저장 실패");
    } finally {
      bitmap?.close();
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <fieldset ref={field} className="cover-input" disabled={busy}>
      <legend>표지 이미지 추가</legend>
      <div className="inline-options">
        <label>
          <input
            type="radio"
            name="coverMode"
            checked={mode === "file"}
            onChange={() => setMode("file")}
          />
          파일 선택
        </label>
        <label>
          <input
            type="radio"
            name="coverMode"
            checked={mode === "url"}
            onChange={() => setMode("url")}
          />
          이미지 주소 입력
        </label>
      </div>
      <input type="hidden" name="coverUrl" value={value} />
      {mode === "url" ? (
        <input
          aria-label="표지 이미지 주소"
          type="url"
          value={value.startsWith("/api/") ? "" : value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={2000}
          placeholder="https://…"
        />
      ) : (
        <input
          aria-label="표지 파일 선택"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={busy}
          onChange={(e) => void upload(e.target.files?.[0])}
        />
      )}
      {busy && <small role="status">표지를 저장하고 있습니다…</small>}
      {(value || previewUrl) && (
        <div className="cover-input-preview">
          <img src={previewUrl || value} alt="선택한 표지" />
          {value && (
            <button type="button" onClick={() => onChange("")}>
              표지 제거
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
