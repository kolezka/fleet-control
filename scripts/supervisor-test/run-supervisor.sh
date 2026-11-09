#!/bin/bash
# Paid test supervisor for Fleet Control (Haiku). Run only with the user's approval.
# Only the fleet-control MCP tools; no built-in tools, no user/project settings or plugins.
# Usage: run-supervisor.sh <empty-work-dir> [port]   (start tmux without NO_COLOR, see docs/implementation-status.md)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=${1:?empty work dir}; port=${2:-4894}
cd "$work"
# Auth comes from the env block in user settings, which --setting-sources "" skips. Copy only those keys.
while IFS=$'\t' read -r k v; do export "$k=$v"; done < <(jq -r '.env | to_entries[] | select(.key | test("^(ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY)$")) | [.key, (.value|tostring)] | @tsv' ~/.claude/settings.json)
exec claude --model haiku \
  --setting-sources "" --strict-mcp-config \
  --mcp-config "{\"mcpServers\":{\"fleet-control\":{\"type\":\"http\",\"url\":\"http://127.0.0.1:${port}/mcp\"}}}" \
  --tools "" \
  --allowedTools "mcp__fleet-control__command_get,mcp__fleet-control__command_respond,mcp__fleet-control__command_report" \
  --permission-mode dontAsk \
  --append-system-prompt-file "$here/prompt.txt" \
  -n fc-test-supervisor
