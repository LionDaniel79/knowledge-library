import { materialPageQuery } from "@/lib/material-query";
import { categories } from "@/lib/catalog";
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
  SELECT * FROM normalized WHERE ($2='all' OR kind=$2) AND ($3='all' OR category=CASE WHEN $3='unclassified' THEN '' ELSE $3 END)
    AND ($4='all' OR ($4='unclassified' AND cardinality(topic_ids)=0) OR $4=ANY(topic_ids))
    AND ($5='' OR strpos(lower(search_text),lower($5))>0 OR (kind='book' AND (
      category=ANY($6::text[]) OR strpos(regexp_replace(lower(title||' '||text),'[[:space:]　 ]+','','g'),regexp_replace(lower($5),'[[:space:]　 ]+','','g'))>0
    )))
    AND ($7='all' OR (kind='note' AND (($7='unclassified' AND btrim(title) IN ('','미분류 메모')) OR note_type=$7)))
    AND ($8='all' OR (kind='note' AND (($8='untagged' AND cardinality(tags)=0) OR $8=ANY(tags))))
    AND ($9='all' OR (kind='note' AND (($9='unlinked' AND book_id IS NULL) OR book_id=$9)))
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
    args = [
      owner,
      p.kind,
      p.category,
      p.topic,
      p.q,
      categories
        .filter(([, name]) => name.toLowerCase().includes(p.q.toLowerCase()))
        .map(([id]) => id),
      p.noteType,
      p.tag,
      p.bookId,
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
        ` SELECT id,kind,title,text,category,version,created_at AS "createdAt",updated_at AS "updatedAt",book_id AS "bookId",book_title AS "bookTitle",topic_ids AS "topicIds",topic_names AS "topicNames",note_type AS "noteType",tags FROM filtered ORDER BY ${orders[p.sort]} LIMIT $11 OFFSET $10`,
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
