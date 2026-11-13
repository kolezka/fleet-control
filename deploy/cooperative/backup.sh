#!/usr/bin/env bash
# Backup of the cooperative database. Run on the host that runs the compose stack.
# Usage: backup.sh <new archive path> [--check-restore]
# Dumps database "fleet" from the postgres container (custom format, file mode 0600, refuses to
# overwrite), then lists the archive with pg_restore to check it is readable. With --check-restore
# it also restores the archive into a throwaway database in the same server, compares the table
# list and row counts of schema fleet_cooperative_v1 with the live database and drops the
# throwaway database again. The live database is only read.
# A backup still needs a second copy on another machine; this script does not copy it.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${1:?new archive path}"
check_restore="${2:-}"
[[ -z "$check_restore" || "$check_restore" == "--check-restore" ]] || { echo "unknown option: $check_restore" >&2; exit 2; }
[[ -e "$out" ]] && { echo "refusing to overwrite $out" >&2; exit 1; }
umask 077
cd "$here"
pg() { docker compose exec -T postgres "$@"; }
schema=fleet_cooperative_v1
# noclobber: a file created between the check above and here is not overwritten either.
set -o noclobber
pg pg_dump -U postgres -d fleet --format=custom > "$out" || { rm -f "$out"; echo "pg_dump failed" >&2; exit 1; }
set +o noclobber
listing="$(pg pg_restore --list < "$out")"
grep -q '^; *Format: CUSTOM' <<< "$listing" || { echo "archive listing is not a custom-format dump" >&2; exit 1; }
entries="$(sed -n 's/^; *TOC Entries: *//p' <<< "$listing")"
sha="$(shasum -a 256 "$out" 2>/dev/null || sha256sum "$out")"
echo "archive $out bytes $(wc -c < "$out" | tr -d ' ') sha256 ${sha%% *} toc_entries $entries"
[[ -z "$check_restore" ]] && exit 0

scratch="restore_check_$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
cleanup() { pg dropdb -U postgres --if-exists "$scratch" >/dev/null 2>&1 || echo "could not drop $scratch, drop it by hand" >&2; }
trap cleanup EXIT
pg createdb -U postgres "$scratch"
pg pg_restore -U postgres -d "$scratch" --exit-on-error --no-owner --no-privileges < "$out"
counts() {
  # One query: a list of per-table counts joined with UNION ALL, run with \gexec.
  pg psql -U postgres -d "$1" -XAtq -v ON_ERROR_STOP=1 <<SQL
SELECT string_agg(format('SELECT %L || '' '' || count(*) FROM %I.%I', table_name, table_schema, table_name), ' UNION ALL ' ORDER BY table_name)
FROM information_schema.tables WHERE table_schema = '$schema' AND table_type = 'BASE TABLE' \gexec
SQL
}
live="$(counts fleet)"
restored="$(counts "$scratch")"
[[ -n "$live" ]] || { echo "no tables in $schema" >&2; exit 1; }
tables="$(wc -l <<< "$live" | tr -d ' ')"
if [[ "$(cut -d' ' -f1 <<< "$live")" != "$(cut -d' ' -f1 <<< "$restored")" ]]; then echo "restore check failed: table lists differ" >&2; exit 1; fi
if [[ "$live" == "$restored" ]]; then
  echo "restore check ok: $tables tables, row counts equal to the live database"
else
  # Writes after the dump make the live counts move on; show both for the operator to judge.
  echo "restore check: $tables tables restored; row counts differ from live (writes since the dump?):"
  diff <(echo "$live") <(echo "$restored") | sed -n 's/^[<>] /  /p' >&2 || true
  exit 3
fi
