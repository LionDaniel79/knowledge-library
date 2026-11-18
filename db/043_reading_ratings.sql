-- Reuse the existing synced/backed-up cycle metadata without changing backup columns.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='library_cycles'::regclass AND conname='library_cycle_rating_check') THEN
  ALTER TABLE library_cycles ADD CONSTRAINT library_cycle_rating_check CHECK(
   source_data IS NULL OR NOT(source_data ? 'readingRating') OR
   coalesce(jsonb_typeof(source_data->'readingRating')='object' AND source_data->'readingRating' ? 'steps' AND
   (source_data#>'{readingRating,steps}'='null'::jsonb OR
    (jsonb_typeof(source_data#>'{readingRating,steps}')='number' AND source_data#>>'{readingRating,steps}' ~ '^(10|[0-9])$')),false)
  );
 END IF;
END $$;
