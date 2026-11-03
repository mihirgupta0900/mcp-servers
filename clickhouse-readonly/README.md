# clickhouse-readonly

A strictly read-only MCP server that lets Claude inspect and query ClickHouse in
**two environments at once** — `prod` and `stag` — and in **any number of
clusters per environment**. Sibling of `../postgres-readonly`, same shape, same
guarantees.

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_clusters` | `env?`, `probe?`, `table_like?` | each env's clusters: name, default flag, host, port, database; probed for reachability, version and table count; with `table_like`, the matching tables on each |
| `list_databases` | `env` (`prod` \| `stag`), `cluster?` | databases with engine, table count, total rows, size |
| `list_tables` | `env`, `cluster?`, `database`, `include_views?`, `name_like?` | tables with engine, rows, size, **sorting key** and partition key |
| `run_query` | `env`, `cluster?`, `sql`, `database?`, `params?`, `limit?`, `timeout_ms?` | columns + types, rows, row count, elapsed ms, rows/bytes read, truncation flag |

### Clusters

An environment can be split over several ClickHouse clusters — separate
services with their own hosts, credentials and data — so a given org's tables
live on exactly one of them. Every tool takes an optional `cluster`; omitted,
it is the environment's default cluster, so existing calls behave as before.
Every result names the `env`, `cluster` and `host` it came from.

`list_clusters` shows what is configured, never credentials. With
`table_like: "acme_%"` it counts and samples the matching tables on every
cluster, which is the quickest way to find where an org's data lives.

`list_tables` returns the sorting and partition key on purpose: in ClickHouse
those decide whether a query is fast or a full scan, so they matter before
writing one.

### run_query

Accepts a single `SELECT`, `WITH`, `SHOW`, `DESCRIBE`, `EXPLAIN`, `EXISTS`, or
`CHECK`. Anything else is refused before it reaches the server.

- **Placeholders.** ClickHouse uses typed named placeholders, so pass
  `sql: "… WHERE id = {id:UInt64}"` with `params: {"id": 42}` instead of
  inlining values.
- **Row cap.** `limit` defaults to 200, max 5000. The result is **streamed** and
  abandoned as soon as one row past the limit arrives, so a
  `SELECT * FROM huge_table` never transfers more than the cap regardless of
  server settings. Truncation is reported as `truncated: true`. Values over
  4000 chars are clipped with a marker.
- **Timeouts.** `timeout_ms` (default 30000, max 120000) is applied client-side
  as a hard request abort, and server-side as `max_execution_time` where the
  server accepts it (see below).
- **Stats.** Every result carries `elapsed_ms`, `rows_read` and `bytes_read`,
  which is how you tell a well-targeted query from an accidental full scan.

## Configuration

Credentials live in `.env` next to `server.js` (gitignored, `chmod 600`), so they
stay out of the Claude config files. Real environment variables override the file.

```
CLICKHOUSE_PROD_HOST=      CLICKHOUSE_STAG_HOST=
CLICKHOUSE_PROD_USER=      CLICKHOUSE_STAG_USER=
CLICKHOUSE_PROD_PASSWORD=  CLICKHOUSE_STAG_PASSWORD=
```

Optional per environment: `..._SECURE` (default `1` → HTTPS, the ClickHouse
Cloud setup; set `0` for plain HTTP), `..._PORT` (defaults to 8443 secure /
8123 plain), `..._DATABASE` (default `default`), `..._TIMEOUT_MS`.
See `.env.example`.

That un-prefixed set is the environment's **default cluster**, named by
`CLICKHOUSE_<ENV>_CLUSTER_NAME` (default `default`). Each further cluster gets
its own prefixed set, `CLICKHOUSE_<ENV>_<CLUSTER>_HOST`, `_USER`, `_PASSWORD`
and the same optional keys; the tools call it `<cluster>` in lower case.

From SSM, `load-env-from-ssm.sh` writes the two default clusters and
`add-cluster-from-ssm.sh` adds or refreshes one more without touching the rest:

```
./add-cluster-from-ssm.sh prod cluster_2 /myorg/prod/clickhouse/cluster_2
```

Both scripts quote every value: Node's `.env` parser cuts an unquoted value at
`#`. Restart the MCP after changing `.env`.

## How read-only is enforced

ClickHouse differs from Postgres in one important way: **its `readonly` setting
blocks writes, but does not stop a `SELECT` from reading a remote URL or the
local filesystem.** So the layers are:

1. **Server-side read-only mode: `readonly=1`.** ClickHouse then refuses every
   INSERT, ALTER, CREATE, DROP, TRUNCATE, RENAME, OPTIMIZE, GRANT and SYSTEM
   statement, and a query cannot lower `readonly` itself
   ("Cannot modify 'readonly' setting in readonly mode").

   `readonly=1` rather than `2`, verified against ClickHouse 26.2/26.8:
   **`readonly=2` still allows `url()`, `file()` and `SET`** — it only blocks
   writes — so it is strictly weaker. `readonly=1` blocks those too.

   The cost is that strict servers refuse *all* other settings under
   `readonly=1`. That varies by deployment: stag accepts resource limits
   alongside it, prod rejects them
   ("Cannot modify 'max_execution_time' setting in readonly mode"). So the
   server discovers this per environment at runtime and retries once with
   `readonly` alone — which is safe precisely because the row cap and timeout
   are also enforced client-side, by streaming. `allow_ddl` is deliberately
   never sent: on some versions it is itself a protected setting and rejecting
   it broke prod, while `readonly=1` already blocks DDL.
2. **Statement allowlist.** The SQL must begin with a read keyword; a leading
   `INSERT`/`ALTER`/`SYSTEM`/`SET`/`USE` is refused outright. Only one statement
   is accepted — `SELECT 1; DROP TABLE t` is rejected as two.
3. **External-access denylist.** Table functions that reach outside the server —
   `url`, `file`, `s3`, `remote`, `mysql`, `postgresql`, `hdfs`,
   `azureBlobStorage`, `executable`, and friends — are refused. This is the
   layer `readonly` does *not* give you: without it a read-only `SELECT` could
   still read `/etc/passwd` or POST your data to another host.
4. **Comment and literal stripping.** The guard lexes the statement first,
   removing `--` / `/* */` comments and quoted strings, so `WHERE name = 'drop
   table'` is not a false positive and `SELECT 1 -- \nDROP TABLE t` cannot hide a
   second statement.

Deliberately *not* in the keyword denylist: `system`, `set`, `kill`, `use`.
`SELECT … FROM system.tables` is essential read-only introspection, and a
`SYSTEM …` statement is already refused by the allowlist — denying the word
would break normal use while adding nothing. For the same reason `SHOW CREATE
TABLE` is allowed: every ClickHouse `SHOW` statement is read-only.

Unlike Postgres, ClickHouse has no data-modifying CTEs, so a write cannot hide
inside a `SELECT`; `EXPLAIN` is still checked so it cannot be used as a wrapper.

For defence in depth, point this at a ClickHouse user created with
`READONLY` profile settings or with only `SELECT` grants.

## Registered with Claude

Both the CLI (`~/.claude.json`) and the desktop app
(`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
"clickhouse-readonly": {
  "command": "/absolute/path/to/mcp-servers/clickhouse-readonly/run.sh"
}
```

`run.sh` resolves node from nvm, since MCP servers are spawned with a minimal `PATH`.
