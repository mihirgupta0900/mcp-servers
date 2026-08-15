#!/bin/bash
# Fetch ClickHouse read-only credentials from AWS SSM straight into the MCP's .env.
# Values are never echoed: they go from the AWS CLI into shell variables and
# then into the file. Only a masked summary is printed.
#
# This is optional -- it is a convenience for setups that already keep ClickHouse
# credentials in SSM Parameter Store. If you don't use SSM, skip this script and
# fill in .env by hand from .env.example.
#
# Configure via environment variables (no defaults -- nothing is hardcoded):
#
#   SSM_PROD_BASE      parameter prefix holding prod host/database
#   SSM_PROD_RO_BASE   parameter prefix holding the prod read-only user/password
#                      (defaults to SSM_PROD_BASE when unset)
#   SSM_STAG_BASE      parameter prefix holding stag host/database
#   SSM_STAG_RO_BASE   parameter prefix holding the stag read-only user/password
#                      (defaults to SSM_STAG_BASE when unset)
#
# The leaf parameter names default to the values below and can be overridden if
# your naming differs -- read-only user/password leaves in particular often vary
# between environments:
#
#   SSM_HOST_KEY (CLICKHOUSE_HOST)  SSM_DB_KEY (CLICKHOUSE_DB)
#   SSM_PROD_USER_KEY (CLICKHOUSE_USER_READONLY)
#   SSM_PROD_PASS_KEY (CLICKHOUSE_PASSWORD_READONLY)
#   SSM_STAG_USER_KEY (CLICKHOUSE_USER_READ)
#   SSM_STAG_PASS_KEY (CLICKHOUSE_PASSWORD_READ)
#
# Example:
#   export SSM_PROD_BASE=/myorg/prod/clickhouse/cluster_1
#   export SSM_STAG_BASE=/myorg/stag/clickhouse/cluster_1
#   ./load-env-from-ssm.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$DIR/.env"

: "${SSM_PROD_BASE:?set SSM_PROD_BASE to the prod parameter prefix}"
: "${SSM_STAG_BASE:?set SSM_STAG_BASE to the stag parameter prefix}"
SSM_PROD_RO_BASE="${SSM_PROD_RO_BASE:-$SSM_PROD_BASE}"
SSM_STAG_RO_BASE="${SSM_STAG_RO_BASE:-$SSM_STAG_BASE}"

SSM_HOST_KEY="${SSM_HOST_KEY:-CLICKHOUSE_HOST}"
SSM_DB_KEY="${SSM_DB_KEY:-CLICKHOUSE_DB}"
SSM_PROD_USER_KEY="${SSM_PROD_USER_KEY:-CLICKHOUSE_USER_READONLY}"
SSM_PROD_PASS_KEY="${SSM_PROD_PASS_KEY:-CLICKHOUSE_PASSWORD_READONLY}"
SSM_STAG_USER_KEY="${SSM_STAG_USER_KEY:-CLICKHOUSE_USER_READ}"
SSM_STAG_PASS_KEY="${SSM_STAG_PASS_KEY:-CLICKHOUSE_PASSWORD_READ}"

get() { # get <ssm-name>  -> value on stdout (caller captures; never printed)
  aws ssm get-parameter --name "$1" --with-decryption --query "Parameter.Value" --output text
}

PROD_HOST="$(get "$SSM_PROD_BASE/$SSM_HOST_KEY")"
PROD_DB="$(get "$SSM_PROD_BASE/$SSM_DB_KEY")"
PROD_USER="$(get "$SSM_PROD_RO_BASE/$SSM_PROD_USER_KEY")"
PROD_PASS="$(get "$SSM_PROD_RO_BASE/$SSM_PROD_PASS_KEY")"

STAG_HOST="$(get "$SSM_STAG_BASE/$SSM_HOST_KEY")"
STAG_DB="$(get "$SSM_STAG_BASE/$SSM_DB_KEY")"
STAG_USER="$(get "$SSM_STAG_RO_BASE/$SSM_STAG_USER_KEY")"
STAG_PASS="$(get "$SSM_STAG_RO_BASE/$SSM_STAG_PASS_KEY")"

# Deliberately not read from an SSM PORT_HTTP parameter: that commonly holds
# 9440, the native-protocol TLS port ("Port 9000 is for clickhouse-client
# program"), not the HTTP one. ClickHouse serves the HTTP interface over TLS on
# 8443. Override below if your deployment differs.
PROD_PORT="${CLICKHOUSE_PROD_PORT:-8443}"; PROD_SECURE="${CLICKHOUSE_PROD_SECURE:-1}"
STAG_PORT="${CLICKHOUSE_STAG_PORT:-8443}"; STAG_SECURE="${CLICKHOUSE_STAG_SECURE:-1}"

umask 077
cat > "$ENV_FILE" <<EOF
# clickhouse-readonly credentials
# Generated from AWS SSM (read-only ClickHouse users) — do not commit.
# prod: \$SSM_PROD_RO_BASE/{$SSM_PROD_USER_KEY,$SSM_PROD_PASS_KEY}
# stag: \$SSM_STAG_RO_BASE/{$SSM_STAG_USER_KEY,$SSM_STAG_PASS_KEY}
#
# WARNING: values are unquoted and may contain shell metacharacters. server.js
# reads this with Node's process.loadEnvFile(), which handles that correctly.
# Do NOT source this file from a shell -- that will misparse the passwords.

CLICKHOUSE_PROD_HOST=$PROD_HOST
CLICKHOUSE_PROD_PORT=$PROD_PORT
CLICKHOUSE_PROD_SECURE=$PROD_SECURE
CLICKHOUSE_PROD_USER=$PROD_USER
CLICKHOUSE_PROD_PASSWORD=$PROD_PASS
CLICKHOUSE_PROD_DATABASE=$PROD_DB

CLICKHOUSE_STAG_HOST=$STAG_HOST
CLICKHOUSE_STAG_PORT=$STAG_PORT
CLICKHOUSE_STAG_SECURE=$STAG_SECURE
CLICKHOUSE_STAG_USER=$STAG_USER
CLICKHOUSE_STAG_PASSWORD=$STAG_PASS
CLICKHOUSE_STAG_DATABASE=$STAG_DB
EOF
chmod 600 "$ENV_FILE"

# Masked summary only: field set/missing, value lengths, and the derived TLS mode.
report() { printf '  %-28s %s\n' "$1" "$([ -n "$2" ] && echo "set (${#2} chars)" || echo "MISSING")"; }
echo "wrote $ENV_FILE ($(wc -l < "$ENV_FILE" | tr -d ' ') lines, mode $(stat -f '%Lp' "$ENV_FILE"))"
echo "prod:"
report CLICKHOUSE_PROD_HOST "$PROD_HOST"
report CLICKHOUSE_PROD_PORT "$PROD_PORT"
report CLICKHOUSE_PROD_USER "$PROD_USER"
report CLICKHOUSE_PROD_PASSWORD "$PROD_PASS"
report CLICKHOUSE_PROD_DATABASE "$PROD_DB"
echo "  derived SECURE=$PROD_SECURE"
echo "stag:"
report CLICKHOUSE_STAG_HOST "$STAG_HOST"
report CLICKHOUSE_STAG_PORT "$STAG_PORT"
report CLICKHOUSE_STAG_USER "$STAG_USER"
report CLICKHOUSE_STAG_PASSWORD "$STAG_PASS"
report CLICKHOUSE_STAG_DATABASE "$STAG_DB"
echo "  derived SECURE=$STAG_SECURE"
