/** Used with alias c. Book versions alone do not change when a PDF is replaced. */
export const currentOutlineDocumentSql = `(
  NOT (c.kind='toc' AND coalesce(c.value->>'method','') IN ('embedded_outline','edited_outline','printed_toc_excerpt'))
  OR EXISTS(SELECT 1 FROM library_documents outline_doc
    WHERE c.source_kind='book' AND outline_doc.owner_id=c.owner_id
      AND outline_doc.book_id::text=c.source_id AND outline_doc.id::text=c.value->>'documentId'
      AND outline_doc.processing_scope='full'
      AND outline_doc.bytes::text || ':' || outline_doc.mtime_ns = c.value->>'signature')
)`;
