import { z } from "zod";
import { contentHash } from "./curation-store";
import { LibraryError, type Executor } from "./library-store";
import type { SourceRef } from "../lib/curation";
import { searchContext, type TopicRelation } from "./library-search-context";
import { currentOutlineDocumentSql } from "./curation-freshness";
export interface SearchHit {
  id: string;
  source: SourceRef;
  layer: "mine" | "source" | "auxiliary";
  title: string;
  quote: string;
  coverage: string;
  origin: string;
  voice: string;
  matchedTerms: string[];
  topicMatches: { id: string; name: string; relation: TopicRelation }[];
}
const querySchema = z.object({
  text: z.string().trim().max(200),
  layer: z.enum(["all", "mine", "source", "auxiliary"]),
  topicId: z.string().uuid().optional(),
  topicScope: z.enum(["exact", "children", "related"]).optional(),
  expandAliases: z.boolean().optional(),
  cursor: z.string().max(500).optional(),
});
export async function searchLibrary(
  db: Executor,
  owner: string,
  query: z.infer<typeof querySchema>,
): Promise<{ items: SearchHit[]; nextCursor: string | null }> {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  const q = querySchema.parse(query),
    context = await searchContext(db, owner, q),
    fingerprint = contentHash(
      JSON.stringify([
        "title-spacing/v2",
        owner,
        q.text,
        q.layer,
        q.topicId ?? null,
        q.topicScope ?? "exact",
        q.expandAliases ?? false,
        context.terms,
        [...context.scope.values()],
      ]),
    );
  let offset = 0;
  if (q.cursor) {
    try {
      const c = JSON.parse(Buffer.from(q.cursor, "base64url").toString());
      if (
        c.key !== fingerprint ||
        !Number.isSafeInteger(c.offset) ||
        c.offset < 0 ||
        c.offset > 100000
      )
        throw Error();
      offset = c.offset;
    } catch {
      throw new LibraryError(
        400,
        "검색 조건이 바뀌었습니다. 처음부터 검색해 주세요.",
      );
    }
  }
  const rows = (
    await db.query(
      `WITH entries AS (
  SELECT 'n:'||n.id AS id,'note' AS kind,n.id::text AS source_id,n.version::text AS version,n.title,n.content AS body,
   CASE WHEN n.kind='highlight' THEN 'quote' ELSE coalesce(e.voice,CASE WHEN (n.source_data IS NULL OR n.source_data='null'::jsonb) AND n.kind IN ('thought','reflection') THEN 'self' ELSE 'unconfirmed' END) END AS voice,
   'full' AS coverage,'original' AS origin,array_to_string(n.tags,' ') AS tags,0 AS aux
  FROM library_active_notes n LEFT JOIN library_thought_events e ON e.owner_id=n.owner_id AND e.note_id=n.id WHERE n.owner_id=$1
  UNION ALL
  SELECT 'b:'||b.id,'book',b.id::text,b.version::text,b.title,concat_ws(' ',b.author,b.publisher,b.isbn), 'source','metadata','original',array_to_string(b.tags,' '),0
  FROM library_books b WHERE b.owner_id=$1
  UNION ALL
  SELECT 'c:'||c.id,c.source_kind,c.source_id,c.source_version,coalesce(b.title,n.title),
   CASE WHEN c.kind='toc' AND jsonb_typeof(c.value->'entries')='array' THEN (SELECT string_agg(e->>'title', E'\n') FROM jsonb_array_elements(c.value->'entries') e)
    WHEN c.kind='toc' AND c.value->>'method'='printed_toc_excerpt' THEN coalesce(c.value->>'editedText',c.value->>'text')
    WHEN jsonb_typeof(c.value)='string' THEN c.value#>>'{}' ELSE c.value::text END,'auxiliary',c.coverage,c.origin,'',1
  FROM library_curation_items c LEFT JOIN library_books b ON c.source_kind='book' AND b.id::text=c.source_id AND b.owner_id=c.owner_id LEFT JOIN library_active_notes n ON c.source_kind='note' AND n.id::text=c.source_id AND n.owner_id=c.owner_id
  WHERE c.owner_id=$1 AND c.state='active' AND c.source_version=coalesce(b.version,n.version)::text
   AND ${currentOutlineDocumentSql}
   AND (b.id IS NULL OR coalesce(b.source_data->>'app','')<>'Local PDF' OR EXISTS(SELECT 1 FROM library_documents d WHERE d.owner_id=b.owner_id AND d.book_id=b.id AND d.processing_scope='full'))
  UNION ALL
  SELECT 'j:'||c.id,c.source_kind,c.source_id::text,coalesce(n.version,b.version)::text,'내 판단 · '||coalesce(n.title,b.title),c.reason,'self','full','human','',0
  FROM library_connections c LEFT JOIN library_active_notes n ON c.source_kind='note' AND n.id=c.source_id AND n.owner_id=c.owner_id LEFT JOIN library_books b ON c.source_kind='book' AND b.id=c.source_id AND b.owner_id=c.owner_id
  WHERE c.owner_id=$1 AND c.status='accepted' AND coalesce(n.id,b.id) IS NOT NULL
    AND (c.target_kind<>'note' OR EXISTS(SELECT 1 FROM library_active_notes t WHERE t.owner_id=c.owner_id AND t.id=c.target_id))
  UNION ALL
  SELECT 'e:'||c.id,'note',n.id::text,n.version::text,'내 생각 연결 · '||n.title,c.comparison->>'explanation','self','full','human','',0
  FROM library_evolution_candidates c JOIN library_active_notes n ON n.owner_id=c.owner_id AND n.id=c.after_id
  WHERE c.owner_id=$1 AND c.status='accepted' AND EXISTS(SELECT 1 FROM library_active_notes t WHERE t.owner_id=c.owner_id AND t.id=c.before_id) AND (
    c.provenance->>'modelDigest'='manual' OR EXISTS(
      SELECT 1 FROM library_analysis_feedback f WHERE f.owner_id=c.owner_id AND f.candidate_id=c.id AND f.decision='accept'
      AND f.corrected_output->>'explanation'=c.comparison->>'explanation'
      AND f.corrected_output->>'explanation' IS DISTINCT FROM f.original_output->>'explanation'
    )
  )
 ), scored AS (
  SELECT *,CASE WHEN aux=1 THEN 'auxiliary' WHEN voice='self' THEN 'mine' ELSE 'source' END AS layer,
   CASE WHEN aux=1 THEN 10 WHEN voice='self' AND EXISTS(SELECT 1 FROM unnest($2::text[]) term WHERE position(lower(term) in lower(body))>0) THEN 100 WHEN EXISTS(SELECT 1 FROM unnest($2::text[]) term WHERE position(regexp_replace(lower(term),'[[:space:]　 ]+','','g') in regexp_replace(lower(title),'[[:space:]　 ]+','','g'))>0) THEN 80 ELSE 60 END AS score
  FROM entries WHERE EXISTS(SELECT 1 FROM unnest($2::text[]) term WHERE position(lower(term) in lower(concat_ws(' ',title,body,tags)))>0 OR position(regexp_replace(lower(term),'[[:space:]　 ]+','','g') in regexp_replace(lower(title),'[[:space:]　 ]+','','g'))>0)
   AND ($4::uuid[] IS NULL OR EXISTS(SELECT 1 FROM library_topic_memberships m WHERE m.owner_id=$1 AND m.topic_id=ANY($4) AND m.source_kind=entries.kind AND m.source_id=entries.source_id AND m.source_version=entries.version AND m.status='accepted'))
 ) SELECT *, (SELECT coalesce(jsonb_agg(m.topic_id),'[]') FROM library_topic_memberships m WHERE m.owner_id=$1 AND m.topic_id=ANY($4::uuid[]) AND m.source_kind=scored.kind AND m.source_id=scored.source_id AND m.source_version=scored.version AND m.status='accepted') AS matched_topics
 FROM scored WHERE ($3='all' OR layer=$3) ORDER BY score DESC,id LIMIT 21 OFFSET $5`,
      [
        owner,
        context.terms,
        q.layer,
        q.topicId ? [...context.scope.keys()] : null,
        offset,
      ],
    )
  ).rows;
  return {
    items: rows.slice(0, 20).map((r) => {
      const body = r.body ?? "";
      const matchedTerms = context.terms.filter(
        (t) =>
          !!t &&
          (`${r.title} ${body} ${r.tags}`
            .toLowerCase()
            .includes(t.toLowerCase()) ||
            String(r.title ?? "")
              .replace(/\s+/g, "")
              .toLowerCase()
              .includes(t.replace(/\s+/g, "").toLowerCase())),
      );
      const start = Math.max(
        0,
        body
          .toLowerCase()
          .indexOf(
            (
              matchedTerms.find((t) =>
                body.toLowerCase().includes(t.toLowerCase()),
              ) ?? q.text
            ).toLowerCase(),
          ) - 100,
      );
      return {
        id: r.id,
        source: { kind: r.kind, id: r.source_id, version: r.version },
        layer: r.layer,
        title: r.title,
        quote: body.slice(start, start + 500),
        matchedTerms,
        topicMatches: (r.matched_topics as string[]).flatMap((id) => {
          const t = context.scope.get(id);
          return t ? [t] : [];
        }),
        coverage: r.coverage,
        origin: r.origin,
        voice: r.voice,
      };
    }),
    nextCursor:
      rows.length > 20
        ? Buffer.from(
            JSON.stringify({ key: fingerprint, offset: offset + 20 }),
          ).toString("base64url")
        : null,
  };
}
