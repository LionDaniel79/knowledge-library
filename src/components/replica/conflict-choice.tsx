"use client";
import type { ConflictPreview } from "@/lib/replica/conflict-presentation";

export function ConflictChoice({
  name,
  title,
  description,
  preview,
  selected,
  disabled = false,
  onSelect,
}: {
  name: string;
  title: string;
  description: string;
  preview: ConflictPreview;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  const fields = preview.fields.some((f) => f.different)
    ? preview.fields.filter((f) => f.different)
    : preview.fields;
  const points = preview.board?.points ?? [];
  const left = Math.min(0, ...points.map((p) => p.x)),
    top = Math.min(0, ...points.map((p) => p.y)),
    width = Math.max(1, ...points.map((p) => p.x - left + 32)),
    height = Math.max(1, ...points.map((p) => p.y - top + 24));
  return (
    <label
      className={`sync-choice-card${selected ? " selected" : ""}${disabled ? " disabled" : ""}`}
    >
      <input
        type="radio"
        name="sync-content-choice"
        aria-label={name}
        checked={selected}
        disabled={disabled}
        onChange={onSelect}
      />
      <span className="sync-choice-heading">{title}</span>
      <span className="sync-choice-caption">{description}</span>
      {preview.title && (
        <strong className="sync-preview-title">{preview.title}</strong>
      )}
      {preview.intent && (
        <strong className="sync-preview-intent">{preview.intent}</strong>
      )}
      {preview.image && (
        <img
          className="sync-cover-preview"
          src={preview.image}
          alt={`${title} 표지`}
          referrerPolicy="no-referrer"
          loading="lazy"
        />
      )}
      {preview.missing ? (
        <p>해당 자료가 없습니다.</p>
      ) : (
        <>
          {!!points.length && (
            <svg
              className="sync-board-preview"
              role="img"
              aria-label={`${title} 화이트보드 배치 미리보기`}
              viewBox="0 0 360 150"
            >
              <rect x="0" y="0" width="360" height="150" fill="#f4f7f0" />
              {points.map((p, i) => (
                <rect
                  key={i}
                  x={10 + ((p.x - left) / width) * 330}
                  y={10 + ((p.y - top) / height) * 120}
                  width="9"
                  height="7"
                  rx="1"
                  fill={i % 3 === 0 ? "#bdcebb" : "#e7cf91"}
                />
              ))}
            </svg>
          )}
          {!!fields.length && (
            <dl className="sync-preview-fields">
              {fields.map((f) => (
                <div key={f.key} className={f.different ? "different" : ""}>
                  <dt>{f.label}</dt>
                  <dd
                    className={
                      f.key === "current_page" ? "sync-page-value" : ""
                    }
                  >
                    {f.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {preview.body !== undefined && (
            <div className="sync-preview-body">
              {preview.body || "내용 없음"}
            </div>
          )}
        </>
      )}
      <span className="sync-choice-foot">
        {selected ? "선택됨" : "이 내용 선택"}
      </span>
    </label>
  );
}
