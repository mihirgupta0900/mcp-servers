#!/bin/bash
# Launcher for clickhouse-readonly-mcp.
# Claude Code spawns MCP servers with a minimal PATH, and node here lives under
# nvm — so resolve it explicitly instead of relying on the inherited PATH.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
  nvm use default >/dev/null 2>&1 || true
  command -v node >/dev/null 2>&1 && NODE_BIN="$(command -v node)"
fi

if [ -z "$NODE_BIN" ]; then
  # Last resort: newest node installed under nvm.
  NODE_BIN="$(ls -1d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1 || true)"
fi

if [ -z "$NODE_BIN" ]; then
  echo "clickhouse-readonly-mcp: could not find a node binary" >&2
  exit 1
fi

exec "$NODE_BIN" "$DIR/server.js" "$@"
