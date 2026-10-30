"use client";
import type { LegacyBoxConflict } from "@/lib/shared-thought-boxes";
export type LegacyThoughtReviewState = {
  legacyConflicts?: LegacyBoxConflict[];
  legacyToken?: string;
};
export function LegacyThoughtReview({
  state,
  busy,
  onMerge,
}: {
  state?: LegacyThoughtReviewState | null;
  busy: boolean;
  onMerge: (token: string) => void;
}) {
  if (!state?.legacyConflicts?.length || !state.legacyToken) return null;
  return (
    <section className="notice" aria-label="이전 상자 메모 확인">
      <p>이전 기기의 상자에만 있는 메모를 보관하고 있습니다.</p>
      {state.legacyConflicts.map((c) => (
        <p key={c.id}>
          {c.title} · 추가 메모 {c.extraNoteIds.length}개
        </p>
      ))}
      <button
        type="button"
        disabled={busy}
        onClick={() => onMerge(state.legacyToken!)}
      >
        원본에 추가 메모 합치기
      </button>
    </section>
  );
}
