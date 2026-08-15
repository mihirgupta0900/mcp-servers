# postgres-readonly

A minimal, strictly read-only MCP server that lets Claude Code inspect Postgres
in **two environments at once** — `prod` and `stag`. Every tool takes an `env`
parameter that picks the connection profile.

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_databases` | `env` (`prod` \| `stag`) | every database on that server with owner, encoding, size |
| `list_tables` | `env`, `database`, `schema?`, `include_views?`, `include_system?` | tables in that database with schema, type, owner, total size, approximate row count |
| `run_query` | `env`, `database`, `sql`, `params?`, `limit?`, `timeout_ms?` | column names + types, rows, row count, elapsed ms, and whether the result was truncated |

Example asks:

- "list the databases on stag"
- "what tables are in the `analytics` schema of `app_db` on prod?"
- "on stag, how many users signed up per day last week?"

### run_query

Accepts a **single** `SELECT`, `EXPLAIN` (wrapping a SELECT), or `SHOW`.
Anything else is refused before it reaches the database.

- **Placeholders.** Use `$1, $2, …` with `params` instead of concatenating
  values into the SQL.
- **Row cap.** `limit` defaults to 200, max 5000. The server reads one row past
  the limit through a cursor, so it can report `truncated: true` without pulling
  the whole result set into memory. Individual values longer than 4000 chars are
  clipped with a marker.
- **Timeouts.** `timeout_ms` (max 120000) overrides the environment's statement
  timeout for that one query, via `SET LOCAL`.
- **Errors** come back with the Postgres message, hint, and character position,
  so a bad query can be corrected and retried.
- `bigint` values are returned as numbers when exactly representable and as
  strings when they would lose precision; `numeric` stays a string on purpose.

## Configuration

Credentials live in `.env` next to `server.js` (gitignored, `chmod 600`), so
they stay out of the Claude Code config file. Real environment variables, if
set, override the file.

```
PG_PROD_HOST=      PG_STAG_HOST=
PG_PROD_PORT=5432  PG_STAG_PORT=5432
PG_PROD_USER=      PG_STAG_USER=
PG_PROD_PASSWORD=  PG_STAG_PASSWORD=
```

Optional per environment (`PG_PROD_*` / `PG_STAG_*`):

- `..._DATABASE` — database for the initial connection used by `list_databases` (default `postgres`)
- `..._SSL` — `disable` | `require` (default; encrypts without verifying the certificate, same as libpq's `require`) | `verify-full`
- `..._SSL_CA` — path to a CA bundle, used with `verify-full`
- `..._STATEMENT_TIMEOUT_MS` — default `15000`
- `..._NO_STARTUP_OPTIONS=1` — skip startup GUCs if a pooler (PgBouncer transaction mode) rejects them

See `.env.example` for the full annotated list.

## How read-only is enforced

Four independent layers, so no single mistake makes a write possible:

1. **Parsed, not pattern-matched.** `run_query` sends the SQL through the real
   PostgreSQL parser (`libpg-query`) and inspects the syntax tree:
   - exactly one statement — `SELECT 1; DROP TABLE users` is rejected as two;
   - the top-level node must be `SelectStmt` / `ExplainStmt` / `VariableShowStmt`;
   - the **whole tree** is walked for write nodes, because a data-modifying CTE
     like `WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d` parses as
     a top-level `SELECT`. A regex-based filter accepts that query; this does not.
   - function calls are checked against a denylist of things that reach *outside*
     the transaction, which a read-only transaction cannot stop: `dblink`,
     `pg_read_file`, `lo_export`, `pg_terminate_backend`, `set_config`, and friends.

   Because it is a parser and not a keyword scan, ordinary queries such as
   `WHERE status = 'delete'` or `SELECT created_at` are not false positives.
   The listing tools accept no SQL at all — their queries are fixed in `server.js`.
2. **Read-only session.** Connections start with
   `-c default_transaction_read_only=on`, plus a statement timeout and an
   idle-in-transaction timeout.
3. **Read-only transaction.** Every query runs inside
   `BEGIN TRANSACTION READ ONLY` … `COMMIT`. Postgres itself rejects
   `INSERT`/`UPDATE`/`DELETE`/`CREATE`/`DROP`/`ALTER`/`TRUNCATE` here.
4. **Statement guard on internal SQL.** The server's own fixed queries also pass
   through `assertReadOnlySql()`, which requires `SELECT`/`WITH` and rejects
   write verbs and `;`.

Queries additionally run over the extended query protocol (via a cursor), which
cannot carry a second statement even if the parser check were bypassed.
Identifiers are never string-interpolated: the database name is validated
against `pg_database` before use, and schema names and query values are bound
parameters.

Verified against a real PostgreSQL 18 instance. `INSERT`, `UPDATE`, `DELETE`,
`DROP`, `TRUNCATE`, `ALTER`, `CREATE`, `GRANT`, `COPY`, `DO`, `CALL`, `VACUUM`,
`REFRESH MATERIALIZED VIEW`, `BEGIN`/`COMMIT`, `SET`, `PREPARE`, stacked
statements, data-modifying CTEs, and each denied function are all rejected;
directly attempting a write on the same connection settings fails with
`cannot execute … in a read-only transaction`, and the seeded data is unchanged
afterwards.

For defence in depth, still point this at a Postgres role that only has
`CONNECT` + `SELECT`.

## Registered with Claude Code

User scope, so it is available in every project:

```json
"postgres-readonly": {
  "command": "/absolute/path/to/mcp-servers/postgres-readonly/run.sh"
}
```

`run.sh` resolves node from nvm, since Claude Code spawns MCP servers with a
minimal `PATH`.

## Local check

```bash
/absolute/path/to/mcp-servers/postgres-readonly/run.sh
```

It should start and wait on stdin (that is the MCP stdio transport). Ctrl-C to exit.
