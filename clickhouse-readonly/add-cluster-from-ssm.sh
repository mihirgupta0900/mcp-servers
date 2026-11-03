#!/bin/bash
# Add (or refresh) one extra ClickHouse cluster in the MCP's .env from AWS SSM.
#
#   ./add-cluster-from-ssm.sh <env> <cluster> <ssm-base> [user-key] [pass-key] [ro-base]
#
#   env       prod | stag
#   cluster   the name tools use for it, e.g. cluster_2 (lowercase, digits, _)
#   ssm-base  parameter prefix holding CLICKHOUSE_HOST and CLICKHOUSE_DB
#   user-key  leaf name of the read-only user     (default CLICKHOUSE_USER_READ)
#   pass-key  leaf name of the read-only password (default CLICKHOUSE_PASSWORD_READ)
#   ro-base   prefix holding the user/password    (default ssm-base)
#
# Example:
#   ./add-cluster-from-ssm.sh prod cluster_2 /myorg/prod/clickhouse/cluster_2
#
# The cluster is written as CLICKHOUSE_<ENV>_<CLUSTER>_* lines. Existing lines
# for other clusters, and the env's default cluster, are left untouched;
# re-running replaces only this cluster's lines. Values are never echoed: they
# go from the AWS CLI into shell variables and then into the file. Only a
# masked summary is printed. Restart the MCP afterwards.
#
# To give the env's default cluster a real name (so `cluster: "cluster_1"`
# works as well as omitting it), add CLICKHOUSE_<ENV>_CLUSTER_NAME=cluster_1.
set -euo pipefail

usage() { sed -n '2,13p' "$0" >&2; exit 2; }
[ $# -ge 3 ] || usage

ENV_NAME="$1"; CLUSTER="$2"; BASE="$3"
USER_KEY="${4:-CLICKHOUSE_USER_READ}"
PASS_KEY="${5:-CLICKHOUSE_PASSWORD_READ}"
RO_BASE="${6:-$BASE}"

case "$ENV_NAME" in prod|stag) ;; *) echo "env must be prod or stag" >&2; exit 2 ;; esac
[[ "$CLUSTER" =~ ^[a-z0-9][a-z0-9_]*$ ]] || { echo "cluster must match ^[a-z0-9][a-z0-9_]*$" >&2; exit 2; }

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$DIR/.env"
PREFIX="CLICKHOUSE_$(tr '[:lower:]' '[:upper:]' <<<"$ENV_NAME")_$(tr '[:lower:]' '[:upper:]' <<<"$CLUSTER")_"

get() { # get <ssm-name>  -> value on stdout (caller captures; never printed)
  aws ssm get-parameter --name "$1" --with-decryption --query "Parameter.Value" --output text
}

HOST="$(get "$BASE/CLICKHOUSE_HOST")"
DB="$(get "$BASE/CLICKHOUSE_DB")"
USER_VAL="$(get "$RO_BASE/$USER_KEY")"
PASS_VAL="$(get "$RO_BASE/$PASS_KEY")"
# An SSM host can carry the native port (e.g. host:9440); the HTTP interface is 8443.
HOST="${HOST%%:*}"

# Node's .env parser cuts an unquoted value at "#", so quote every value with a
# quote character it does not contain. Single and backtick quotes are literal.
q() {
  local v="$1"
  if [[ "$v" != *"'"* ]]; then printf "'%s'" "$v"
  elif [[ "$v" != *'`'* ]]; then printf '`%s`' "$v"
  elif [[ "$v" != *'"'* && "$v" != *'\\'* ]]; then printf '"%s"' "$v"
  else echo "value contains every quote character; set it by hand" >&2; exit 1
  fi
}

# A heredoc ignores a failed $(q ...), so check every value first.
for v in "$HOST" "$DB" "$USER_VAL" "$PASS_VAL"; do q "$v" >/dev/null; done

umask 077
TMP="$(mktemp "$DIR/.env.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
if [ -f "$ENV_FILE" ]; then
  # Keep everything except this cluster's previous block.
  grep -v -e "^${PREFIX}" -e "^# cluster ${ENV_NAME}/${CLUSTER} " "$ENV_FILE" > "$TMP" || true
  # Drop trailing blank lines so re-runs do not pile them up.
  printf '%s\n' "$(cat "$TMP")" > "$TMP.trim" && mv "$TMP.trim" "$TMP"
fi
cat >> "$TMP" <<EOF

# cluster ${ENV_NAME}/${CLUSTER} from SSM ${BASE} (user/password: ${RO_BASE}/{${USER_KEY},${PASS_KEY}})
${PREFIX}HOST=$(q "$HOST")
${PREFIX}PORT=8443
${PREFIX}SECURE=1
${PREFIX}USER=$(q "$USER_VAL")
${PREFIX}PASSWORD=$(q "$PASS_VAL")
${PREFIX}DATABASE=$(q "$DB")
EOF
chmod 600 "$TMP"
mv "$TMP" "$ENV_FILE"
trap - EXIT

report() { printf '  %-40s %s\n' "$1" "$([ -n "$2" ] && echo "set (${#2} chars)" || echo "MISSING")"; }
echo "updated $ENV_FILE with ${ENV_NAME}/${CLUSTER}"
report "${PREFIX}HOST" "$HOST"
report "${PREFIX}USER" "$USER_VAL"
report "${PREFIX}PASSWORD" "$PASS_VAL"
report "${PREFIX}DATABASE" "$DB"
echo "Restart the clickhouse-readonly MCP to pick it up."
