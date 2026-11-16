#!/usr/bin/env bash
# Backup of the cooperative database. Run on the host that runs the compose stack.
# Usage: backup.sh <new archive path> [--check-restore]
# Dumps database "fleet" from the postgres container (custom format, file mode 0600, refuses to
# overwrite), then lists the archive with pg_restore to check it is readable. With --check-restore
# it also restores the archive into a throwaway database in the same server, compares the table
# list, row counts and row content digests of schema fleet_cooperative_v1 with the live database
# (schema-fingerprint.sql next to this script), then its column, constraint, index, trigger,
# function and sequence definitions (schema-definition.sql), prints one fingerprint of the restored
# schema and drops the throwaway database again. Row contents are never printed. The live database is only read.
# A backup still needs a second copy on another machine; this script does not copy it.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${1:?new archive path}"
check_restore="${2:-}"
[[ -z "$check_restore" || "$check_restore" == "--check-restore" ]] || { echo "unknown option: $check_restore" >&2; exit 2; }
[[ -e "$out" ]] && { echo "refusing to overwrite $out" >&2; exit 1; }
fingerprint_sql="$here/schema-fingerprint.sql"
definition_sql="$here/schema-definition.sql"
[[ -z "$check_restore" || -r "$fingerprint_sql" ]] || { echo "missing $fingerprint_sql" >&2; exit 1; }
[[ -z "$check_restore" || -r "$definition_sql" ]] || { echo "missing $definition_sql" >&2; exit 1; }
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
# One "<table> <row count> <digest>" line per table, then a last line "fingerprint <sha256>".
# The file goes in on stdin: the container does not see this directory.
fingerprint() { pg psql -U postgres -d "$1" -XAtq -v ON_ERROR_STOP=1 -v schema="$schema" < "$fingerprint_sql"; }
# psql exits 3 on a failed query. Here 3 means "differs", so a failed read becomes 1.
live="$(fingerprint fleet)" || { echo "restore check failed: could not read $schema in the live database" >&2; exit 1; }
restored="$(fingerprint "$scratch")" || { echo "restore check failed: could not read $schema in the restored database" >&2; exit 1; }
last_line='^fingerprint [0-9a-f]{64}$'
restored_fingerprint="$(tail -n 1 <<< "$restored")"
[[ "$(tail -n 1 <<< "$live")" =~ $last_line && "$restored_fingerprint" =~ $last_line ]] || { echo "restore check failed: unexpected fingerprint output" >&2; exit 1; }
live="$(sed '$d' <<< "$live")"
restored="$(sed '$d' <<< "$restored")"
names() { sed 's/ [0-9]* [0-9a-f]*$//'; }
if [[ "$(names <<< "$live")" != "$(names <<< "$restored")" ]]; then echo "restore check failed: table lists differ" >&2; exit 1; fi
tables="$(wc -l <<< "$restored" | tr -d ' ')"
# Columns, constraints, indexes, triggers, functions and sequence values (schema-definition.sql).
definition() { pg psql -U postgres -d "$1" -XAtq -v ON_ERROR_STOP=1 -v schema="$schema" < "$definition_sql"; }
live_definition="$(definition fleet)" || { echo "restore check failed: could not read definitions in the live database" >&2; exit 1; }
restored_definition="$(definition "$scratch")" || { echo "restore check failed: could not read definitions in the restored database" >&2; exit 1; }
if [[ "$live_definition" != "$restored_definition" ]]; then
  # Definitions hold no row contents, so the differing lines can be shown.
  echo "restore check: definitions differ from live (columns, constraints, indexes, triggers, functions or sequence values)"
  diff <(sed '$d' <<< "$live_definition") <(sed '$d' <<< "$restored_definition") | sed -n 's/^</  live    /p; s/^>/  restored/p' >&2 || true
  exit 3
fi
echo "restored definition ${restored_definition##*definition } schema $schema"
# Restore the same archive on another machine and run schema-fingerprint.sql there: same value.
echo "restored fingerprint ${restored_fingerprint#fingerprint } schema $schema tables $tables"
if [[ "$live" == "$restored" ]]; then
  echo "restore check ok: $tables tables, row counts and contents equal to the live database"
else
  differing="" detail=""
  while IFS= read -r live_line <&3 && IFS= read -r restored_line <&4; do
    [[ "$live_line" == "$restored_line" ]] && continue
    differing+="${differing:+, }${live_line% * *}"
    detail+="  live     $live_line"$'\n'"  restored $restored_line"$'\n'
  done 3<<< "$live" 4<<< "$restored"
  # Writes after the dump make the live database move on; show both sides for the operator to judge.
  echo "restore check: $tables tables restored; row counts or contents differ from live in: $differing (writes since the dump?)"
  printf '%s' "$detail" >&2
  exit 3
fi
