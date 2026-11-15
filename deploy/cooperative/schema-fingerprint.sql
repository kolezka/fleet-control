-- Fingerprint of the row contents of one schema. Read-only: prints table names, row counts and
-- digests, never rows. backup.sh runs this file; an operator can run it against any database:
--   psql -X -d <database> -f schema-fingerprint.sql        (other schema: -v schema=<name>)
-- Output: one "<table> <row count> <digest>" line per table, then "fingerprint <sha256>".
-- The digest is the sha256 of the sorted per-row sha256 of the row text; the fingerprint is the
-- sha256 of the table lines. Equal fingerprints mean the same tables with the same rows.
-- Grants, sequences, indexes and table definitions are not covered. Needs PostgreSQL 11 or newer.
-- The row digests of one table are joined in memory: 32 bytes a row, about 30 million rows at most.
\set QUIET on
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
\if :{?schema}
\else
  \set schema fleet_cooperative_v1
\endif
BEGIN TRANSACTION READ ONLY;
-- Row text depends on these settings. Pin them so the value is the same on every server.
SET LOCAL TimeZone = 'UTC';
SET LOCAL DateStyle = 'ISO, YMD';
SET LOCAL IntervalStyle = 'postgres';
SET LOCAL extra_float_digits = 1;
SET LOCAL bytea_output = 'hex';
SET LOCAL lc_monetary = 'C';
SET LOCAL search_path = pg_catalog;
-- A schema without tables is an error, not an empty fingerprint: a wrong name must not pass.
SELECT set_config('fingerprint.schema', :'schema', true) AS fingerprint_schema \gset
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = current_setting('fingerprint.schema') AND c.relkind IN ('r', 'p')) THEN
    RAISE EXCEPTION 'no tables in schema %', current_setting('fingerprint.schema');
  END IF;
END
$$;
-- Builds one statement over all tables and runs it with \gexec, so every table is read in the
-- same snapshot. Digests are compared as bytes, which keeps the order free of locale rules.
SELECT format(
  'WITH fp_tables(line) AS (%s) '
  'SELECT line FROM ('
  'SELECT 1 AS part, line FROM fp_tables UNION ALL '
  'SELECT 2, ''fingerprint '' || encode(sha256(convert_to(string_agg(line, chr(10) ORDER BY line COLLATE "C"), ''UTF8'')), ''hex'') FROM fp_tables'
  ') AS fp_out ORDER BY part, line COLLATE "C"',
  string_agg(format(
    'SELECT %L || '' '' || count(*) || '' '' || '
    'encode(sha256(coalesce(string_agg(row_digest, ''''::bytea ORDER BY row_digest), ''''::bytea)), ''hex'') '
    'FROM (SELECT sha256(convert_to(fp_row.*::text, ''UTF8'')) AS row_digest FROM %I.%I AS fp_row) AS fp_rows',
    c.relname, n.nspname, c.relname), ' UNION ALL '))
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = :'schema' AND c.relkind IN ('r', 'p')
\gexec
ROLLBACK;
