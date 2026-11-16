-- Definitions of one schema, for comparing a restored copy with the live database. Read-only.
--   psql -X -d <database> -f schema-definition.sql        (other schema: -v schema=<name>)
-- Output: one line per column, constraint, index, trigger, function and sequence, sorted, then
-- "definition <sha256>" over those lines. Sequence lines carry the current value, because a
-- restore that loses it would hand out ids again. Owners and grants are left out: backup.sh
-- restores with --no-owner --no-privileges, so they differ in every restored copy by design.
\set QUIET on
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
\if :{?schema}
\else
  \set schema fleet_cooperative_v1
\endif
BEGIN TRANSACTION READ ONLY;
SET LOCAL search_path = pg_catalog;
SELECT set_config('definition.schema', :'schema', true) AS definition_schema \gset
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = current_setting('definition.schema') AND c.relkind IN ('r', 'p')) THEN
    RAISE EXCEPTION 'no tables in schema %', current_setting('definition.schema');
  END IF;
END
$$;
WITH ns AS (SELECT oid FROM pg_namespace WHERE nspname = :'schema'),
lines(line) AS (
  SELECT format('column %s.%s %s%s%s', c.relname, a.attname, format_type(a.atttypid, a.atttypmod),
                CASE WHEN a.attnotnull THEN ' not null' ELSE '' END,
                coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), ''))
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE c.relnamespace = (SELECT oid FROM ns) AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT format('constraint %s.%s %s', c.relname, k.conname, pg_get_constraintdef(k.oid))
  FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE c.relnamespace = (SELECT oid FROM ns)
  UNION ALL
  SELECT format('index %s', pg_get_indexdef(i.indexrelid))
  FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relnamespace = (SELECT oid FROM ns)
  UNION ALL
  SELECT format('trigger %s', pg_get_triggerdef(t.oid))
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = (SELECT oid FROM ns) AND NOT t.tgisinternal
  UNION ALL
  SELECT format('function %s %s', p.proname, md5(pg_get_functiondef(p.oid)))
  FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM ns) AND p.prokind IN ('f', 'p')
  UNION ALL
  SELECT format('sequence %s %s increment %s last %s', s.sequencename, s.data_type, s.increment_by, coalesce(s.last_value::text, 'unused'))
  FROM pg_sequences s WHERE s.schemaname = :'schema'
)
SELECT line FROM (
  SELECT 1 AS part, line FROM lines
  UNION ALL
  SELECT 2, 'definition ' || encode(sha256(convert_to(coalesce(string_agg(line, chr(10) ORDER BY line COLLATE "C"), ''), 'UTF8')), 'hex') FROM lines
) AS out ORDER BY part, line COLLATE "C";
ROLLBACK;
