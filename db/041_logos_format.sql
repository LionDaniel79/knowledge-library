-- Proven import identities only. Titles, tags and shelves are not evidence.
ALTER TABLE library_books DROP CONSTRAINT IF EXISTS library_books_formats_check;
ALTER TABLE library_books ADD CONSTRAINT library_books_formats_check
 CHECK(cardinality(formats)>0 AND formats <@ ARRAY['paper','logos','ebook','pdf','unknown']::text[]);

CREATE OR REPLACE FUNCTION library_logos_formats(p_formats text[]) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $logos_formats$
 SELECT CASE WHEN 'logos'=ANY(p_formats) THEN p_formats ELSE
 ARRAY(SELECT f FROM unnest(ARRAY['paper','logos','ebook','pdf','unknown']::text[]) f
       WHERE f=ANY(array_replace(p_formats,'ebook','logos')||ARRAY['logos']::text[])) END
$logos_formats$;

CREATE OR REPLACE FUNCTION library_book_logos_format() RETURNS trigger
-- The web role need not gain direct access to private import provenance. This
-- trigger can only normalize the row already being written by that role.
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $book_logos$
BEGIN
 IF lower(NEW.source_data->>'app')='logos' OR EXISTS(
   SELECT 1 FROM public.library_book_sources s WHERE s.owner_id=NEW.owner_id AND s.book_id=NEW.id AND s.source_kind='Logos'
 ) THEN NEW.formats:=public.library_logos_formats(NEW.formats); END IF;
 RETURN NEW;
END
$book_logos$;
REVOKE ALL ON FUNCTION library_book_logos_format() FROM PUBLIC;
DROP TRIGGER IF EXISTS book_logos_format ON library_books;
CREATE TRIGGER book_logos_format BEFORE INSERT OR UPDATE OF formats,source_data ON library_books
 FOR EACH ROW EXECUTE FUNCTION library_book_logos_format();

-- Old backups can restore the source link after its book. Preserve the book ID
-- and all other fields, and let the existing sync capture publish this delta.
CREATE OR REPLACE FUNCTION library_source_logos_format() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $source_logos$
BEGIN
 IF NEW.source_kind='Logos' THEN
  PERFORM public.library_sync_lock(NEW.owner_id);
  UPDATE public.library_books SET formats=public.library_logos_formats(formats),version=version+1
   WHERE owner_id=NEW.owner_id AND id=NEW.book_id
    AND formats IS DISTINCT FROM public.library_logos_formats(formats);
 END IF;
 RETURN NEW;
END
$source_logos$;
DROP TRIGGER IF EXISTS source_logos_format ON library_book_sources;
CREATE TRIGGER source_logos_format AFTER INSERT OR UPDATE OF book_id,owner_id,source_kind ON library_book_sources
 FOR EACH ROW EXECUTE FUNCTION library_source_logos_format();

DO $migrate_logos$
DECLARE selected_owner text;
BEGIN
 FOR selected_owner IN
  SELECT DISTINCT b.owner_id FROM public.library_books b
   WHERE (lower(b.source_data->>'app')='logos' OR EXISTS(
    SELECT 1 FROM public.library_book_sources s WHERE s.owner_id=b.owner_id AND s.book_id=b.id AND s.source_kind='Logos'))
    AND b.formats IS DISTINCT FROM public.library_logos_formats(b.formats) ORDER BY b.owner_id
 LOOP
  PERFORM public.library_sync_lock(selected_owner);
  UPDATE public.library_books b SET formats=public.library_logos_formats(b.formats),version=b.version+1
   WHERE b.owner_id=selected_owner AND (lower(b.source_data->>'app')='logos' OR EXISTS(
    SELECT 1 FROM public.library_book_sources s WHERE s.owner_id=b.owner_id AND s.book_id=b.id AND s.source_kind='Logos'))
    AND b.formats IS DISTINCT FROM public.library_logos_formats(b.formats);
 END LOOP;
END
$migrate_logos$;
