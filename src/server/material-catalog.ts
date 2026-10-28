import { materialPageQuery, materialSelections } from "@/lib/material-query";
import { searchFieldSql, categorySearchTextSql } from "./search-sql";
import type { TopicMaterial } from "@/lib/topic-materials";
import { LibraryError, type Executor } from "./library-store";

const sourceSql = `WITH active_members AS MATERIALIZED (
  SELECT m.source_kind,m.source_id,m.status,t.id::text AS topic_id,t.name
  FROM library_topic_memberships m JOIN library_topics t ON t.owner_id=m.owner_id AND t.id=m.topic_id
  WHERE m.owner_id=$1 AND coalesce(to_jsonb(t)->>'archived_at','')=''
), book_topics AS (
  SELECT source_id,array_agg(topic_id ORDER BY name COLLATE "C",topic_id) AS ids,array_agg(name ORDER BY name COLLATE "C",topic_id) AS names
  FROM active_members WHERE source_kind='book' AND status<>'rejected' GROUP BY source_id
), note_topics AS (
  SELECT source_id,array_agg(topic_id ORDER BY name COLLATE "C",topic_id) AS ids,array_agg(name ORDER BY name COLLATE "C",topic_id) AS names
  FROM (
    SELECT source_id,topic_id,name FROM active_members WHERE source_kind='note' AND status<>'rejected'
    UNION
    SELECT n.id::text,a.topic_id,a.name FROM library_active_notes n
      JOIN active_members a ON a.source_kind='book' AND a.source_id=n.book_id::text AND a.status<>'rejected'
      LEFT JOIN active_members r ON r.source_kind='note' AND r.source_id=n.id::text AND r.topic_id=a.topic_id AND r.status='rejected'
      WHERE n.owner_id=$1 AND r.source_id IS NULL
  ) assignments GROUP BY source_id
), sources AS (
  SELECT n.id::text AS id,'note'::text AS kind,n.title,left(n.content,350) AS text,coalesce(b.category,'') AS raw_category,n.version,n.created_at,n.updated_at,
    n.book_id::text AS book_id,coalesce(b.title,'') AS book_title,coalesce(tm.ids,ARRAY[]::text[]) AS topic_ids,coalesce(tm.names,ARRAY[]::text[]) AS topic_names,
    concat_ws(' ',n.title,n.content,array_to_string(n.tags,' '),b.title) AS search_text,n.kind AS note_type,n.tags
  FROM library_active_notes n LEFT JOIN library_books b ON b.owner_id=n.owner_id AND b.id=n.book_id
  LEFT JOIN note_topics tm ON tm.source_id=n.id::text WHERE n.owner_id=$1
  UNION ALL
  SELECT b.id::text,'book',b.title,concat_ws(' · ',nullif(b.author,''),nullif(b.publisher,'')),coalesce(b.category,''),b.version,b.created_at,b.created_at,
    b.id::text,b.title,coalesce(bt.ids,ARRAY[]::text[]),coalesce(bt.names,ARRAY[]::text[]),concat_ws(' ',b.title,b.author,b.publisher,b.isbn,b.shelf,array_to_string(b.bookshelves,' '),array_to_string(b.tags,' ')),''::text,b.tags
  FROM library_active_books b LEFT JOIN book_topics bt ON bt.source_id=b.id::text WHERE b.owner_id=$1
), normalized AS (
  SELECT *,CASE WHEN btrim(raw_category) ~ '^[0-9]{3}([.]|$)' THEN left(btrim(raw_category),1)||'00' ELSE '' END AS category FROM sources
), filtered AS (
  SELECT * FROM normalized WHERE ($2='all' OR kind=$2) AND (cardinality($3::text[])=0 OR category=ANY($3::text[]))
    AND (cardinality($4::text[])=0 OR ('unclassified'=ANY($4::text[]) AND cardinality(topic_ids)=0) OR topic_ids && $4::text[])
    AND ${searchFieldSql(`concat_ws(' ',search_text,CASE WHEN kind='book' THEN ${categorySearchTextSql("category")} ELSE '' END)`, "$5")}
    AND (cardinality($6::text[])=0 OR (kind='note' AND (('unclassified'=ANY($6::text[]) AND btrim(title) IN ('','미분류 메모')) OR note_type=ANY($6::text[]))))
    AND (cardinality($7::text[])=0 OR (kind='note' AND (('untagged'=ANY($7::text[]) AND cardinality(tags)=0) OR tags && $7::text[])))
    AND (cardinality($8::text[])=0 OR (kind='note' AND (('unlinked'=ANY($8::text[]) AND book_id IS NULL) OR book_id=ANY($8::text[]))))
)`;
const orders = {
  default: `CASE WHEN kind='note' THEN 0 ELSE 1 END,CASE WHEN kind='note' THEN updated_at END DESC,CASE WHEN kind='book' THEN title END COLLATE "C",id COLLATE "C"`,
  newest: `created_at DESC,kind COLLATE "C",id COLLATE "C"`,
  oldest: `created_at ASC,kind COLLATE "C",id COLLATE "C"`,
  category: `nullif(category,'') COLLATE "C" NULLS LAST,created_at DESC,kind COLLATE "C",id COLLATE "C"`,
  topic: `topic_names[1] COLLATE "C" NULLS LAST,created_at DESC,kind COLLATE "C",id COLLATE "C"`,
  book: `nullif(book_title,'') COLLATE "C" NULLS LAST,created_at DESC,kind COLLATE "C",id COLLATE "C"`,
};
export async function readMaterialPage(
  db: Executor,
  owner: string,
  raw: unknown,
): Promise<{ total: number; items: TopicMaterial[] }> {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  const p = materialPageQuery.parse(raw),
    selected = materialSelections(p),
    args = [
      owner,
      p.kind,
      selected.categories.map((category) =>
        category === "unclassified" ? "" : category,
      ),
      selected.topics,
      p.q,
      selected.noteTypes,
      selected.tags,
      selected.bookIds,
    ];
  const total = Number(
    (
      await db.query(
        sourceSql + " SELECT count(*)::int AS total FROM filtered",
        args,
      )
    ).rows[0].total,
  );
  if (!total || p.offset >= total) return { total, items: [] };
  const rows = (
    await db.query(
      sourceSql +
        ` SELECT id,kind,title,text,category,version,created_at AS "createdAt",updated_at AS "updatedAt",book_id AS "bookId",book_title AS "bookTitle",topic_ids AS "topicIds",topic_names AS "topicNames",note_type AS "noteType",tags FROM filtered ORDER BY ${orders[p.sort]} LIMIT $10 OFFSET $9`,
      [...args, p.offset, p.limit],
    )
  ).rows;
  return {
    total,
    items: rows.map((r) => ({
      ...r,
      createdAt: new Date(r.createdAt).toISOString(),
      updatedAt: new Date(r.updatedAt).toISOString(),
    })) as TopicMaterial[],
  };
}
