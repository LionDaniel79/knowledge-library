"use client";
import { useState } from "react";
import type { Library } from "@/lib/domain";
import { FacetPicker } from "./whiteboard/facet-picker";
import { useBookCatalog } from "./use-book-catalog";
export function NoteBookFilter({
  library,
  value,
  onChange,
  values,
  onValuesChange,
}: {
  library: Library;
  value: string;
  onChange: (id: string) => void;
  values?: string[];
  onValuesChange?: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState(""),
    [chosen, setChosen] = useState<{ value: string; label: string }[]>([]);
  const catalog = useBookCatalog({
    enabled: !!library.catalog,
    query: { q: query, sort: "title", limit: 30 },
    revision: library.books,
  });
  const options = [
    ...new Map(
      [
        { value: "unlinked", label: "책과 연결하지 않은 생각" },
        ...chosen,
        ...(library.catalog ? catalog.items : library.books).map((b) => ({
          value: b.id,
          label: b.title,
        })),
      ].map((o) => [o.value, o]),
    ).values(),
  ];
  return (
    <label className="note-book-filter">
      도서명
      <FacetPicker
        compact
        label="도서명"
        multiple={!!onValuesChange}
        options={options}
        values={values ?? (value === "all" ? [] : [value])}
        onSearch={setQuery}
        onChange={(ids) => {
          const id = ids[0] ?? "all";
          setChosen(options.filter((o) => ids.includes(o.value)));
          if (onValuesChange) onValuesChange(ids);
          else onChange(id);
        }}
      />
    </label>
  );
}
