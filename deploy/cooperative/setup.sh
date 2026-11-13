#!/usr/bin/env bash
# Setup of the persistent cooperative central. Run from any directory.
# Usage: setup.sh <absolute state dir> <port> [supervisor host id]
# Writes .env next to compose.yaml, generates secrets into the state directory (never printed),
# starts PostgreSQL, provisions schema and runtime role, activates the supervisor incarnation and
# starts central on 127.0.0.1:<port>. Each step is skipped when its output already exists, so a
# failed run can be repeated with the same arguments. Every step refuses to redo finished work.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
state="${1:?absolute state dir}"
port="${2:?port}"
host="${3:-$(hostname -s)}"
[[ "$state" == /* ]] || { echo "state dir must be absolute" >&2; exit 2; }
[[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )) || { echo "invalid port" >&2; exit 2; }
[[ "$host" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$ ]] || { echo "invalid host id: pass one as the third argument" >&2; exit 2; }
umask 077
mkdir -p "$state"
chmod 700 "$state"
env_text="$(printf 'COOPERATIVE_STATE_DIR=%s\nCOOPERATIVE_PORT=%s\nCOOPERATIVE_UID=%s\nCOOPERATIVE_GID=%s\nCOOPERATIVE_SUPERVISOR_HOST=%s' \
  "$state" "$port" "$(id -u)" "$(id -g)" "$host")"
if [[ -e "$here/.env" ]]; then
  [[ "$(cat "$here/.env")" == "$env_text" ]] || { echo "$here/.env exists with other settings" >&2; exit 1; }
else
  printf '%s\n' "$env_text" > "$here/.env"
fi
step() { echo "== $1"; }
trap 'echo "setup failed at: ${current:-start}. Fix the cause and rerun the same command." >&2' ERR
cd "$here"
current="build"; step "$current"; docker compose build admin
if [[ ! -e "$state/client/adapter.json" ]]; then
  # A partial init has no provisioned database yet, so its files can be removed safely.
  if [[ -e "$state/admin/admin-url" ]]; then echo "partial init in $state: remove $state/{pg,admin,service,client} and rerun" >&2; exit 1; fi
  current="init"; step "$current"; docker compose run --rm --no-deps admin init
fi
current="postgres"; step "$current"; docker compose up -d --wait postgres
if [[ ! -e "$state/service/runtime-url" ]]; then current="provision"; step "$current"; docker compose run --rm admin provision; fi
if [[ ! -e "$state/client/incarnation.json" ]]; then current="activate"; step "$current"; docker compose run --rm admin activate; fi
current="central"; step "$current"; docker compose up -d --wait central
echo "central on http://127.0.0.1:$port; adapter config: $state/client/adapter.json"
