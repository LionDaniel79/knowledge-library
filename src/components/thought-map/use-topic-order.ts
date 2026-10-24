"use client";
import { useEffect, useMemo, useState } from "react";
import type { Topic } from "@/lib/thought-map/types";
export function useTopicOrder(topics: Topic[], owner: string) {
  const key = `library:topic-order:${owner}`;
  const [saved, setSaved] = useState<{ key: string; ids: string[] }>({
    key: "",
    ids: [],
  });
  useEffect(() => {
    let ids: string[] = [];
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? "[]");
      if (Array.isArray(value))
        ids = value.filter((v: unknown): v is string => typeof v === "string");
    } catch {}
    setSaved({ key, ids });
  }, [key]);
  const ordered = useMemo(() => {
    const positions = new Map(
      (saved.key === key ? saved.ids : []).map((id, i) => [id, i]),
    );
    return topics
      .map((t, i) => ({ t, i }))
      .sort(
        (a, b) =>
          (positions.get(a.t.id) ?? 100000 + a.i) -
          (positions.get(b.t.id) ?? 100000 + b.i),
      )
      .map((v) => v.t);
  }, [topics, saved, key]);
  function move(id: string, direction: -1 | 1) {
    const ids = ordered.map((t) => t.id),
      from = ids.indexOf(id),
      to = from + direction;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    setSaved({ key, ids });
    try {
      localStorage.setItem(key, JSON.stringify(ids));
    } catch {}
  }
  return { topics: ordered, move };
}
