# mcp-servers

Two strictly read-only [MCP](https://modelcontextprotocol.io) servers that let
Claude inspect and query databases directly.

| Server | Database | Tools |
|---|---|---|
| [`postgres-readonly`](postgres-readonly) | PostgreSQL | `list_databases`, `list_tables`, `run_query` |
| [`clickhouse-readonly`](clickhouse-readonly) | ClickHouse | `list_databases`, `list_tables`, `run_query` |

Each has its own README with the full tool surface and safety notes.

## Shared conventions

Both servers were built to the same shape, so what you learn from one carries
over to the other.

**Two environments at once.** Each server connects to both `prod` and `stag`.
Every tool takes an `env` parameter selecting which one to hit, rather than
running two server instances with separate configs.

**Read-only, enforced server-side.** The servers reject anything that isn't a
read. That is the first line of defence, not the only one — point them at a
database user that is itself read-only (`SELECT`-only grants on Postgres, a
`READONLY` profile on ClickHouse). See each README for specifics.

**Credentials live in `.env`, never in the repo.** Each server reads a local
`.env` alongside its `server.js`. Both are gitignored. Copy `.env.example` and
fill it in:

```bash
cd postgres-readonly && cp .env.example .env && $EDITOR .env
```

`clickhouse-readonly` also ships an optional `load-env-from-ssm.sh` that
populates `.env` from AWS SSM Parameter Store, for setups that keep credentials
there. Configure it with `SSM_PROD_BASE` / `SSM_STAG_BASE` — see the header of
the script.

**`run.sh` is the entry point, not `server.js`.** Claude Code spawns MCP servers
with a minimal `PATH`, and node under nvm won't be on it. `run.sh` resolves a
node binary explicitly, then execs the server. Always register `run.sh`.

## Setup

```bash
git clone https://github.com/<you>/mcp-servers.git
cd mcp-servers

for d in postgres-readonly clickhouse-readonly; do (cd "$d" && npm install); done
```

Fill in each `.env`, then register the ones you want:

```bash
claude mcp add postgres-readonly --scope user -- /absolute/path/to/mcp-servers/postgres-readonly/run.sh
claude mcp add clickhouse-readonly --scope user -- /absolute/path/to/mcp-servers/clickhouse-readonly/run.sh
```

User scope makes them available in every project. Verify with `claude mcp list`.

To sanity-check a server on its own, run its `run.sh` directly — it should start
and wait on stdin, which is the MCP stdio transport. Ctrl-C to exit.

## Requirements

Node 20.6+ (both servers use `process.loadEnvFile()`), and the AWS CLI only if
you use the ClickHouse SSM helper.
