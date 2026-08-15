#!/usr/bin/env node
/**
 * clickhouse-readonly-mcp
 *
 * A strictly read-only MCP server for ClickHouse, mirroring
 * postgres-readonly-mcp.
 *
 * Tools:
 *   - list_databases(env)
 *   - list_tables(env, database, ...)
 *   - run_query(env, sql, database?, ...)
 *
 * `env` selects a connection profile: "prod" or "stag". Both are configured at
 * the same time via environment variables (see .env.example).
 *
 * Read-only is enforced in four independent layers — see README.md. Note that
 * ClickHouse's own `readonly` setting is the authoritative one; the SQL guard
 * here exists because `readonly` does NOT stop a SELECT from reading the
 * filesystem or a remote URL.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClient } from "@clickhouse/client";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Load <server dir>/.env if present, so credentials live in one file instead of
// being pasted into the Claude Code / Claude Desktop MCP config. Real
// environment variables always win over the file.
const ENV_FILE = path.join(HERE, ".env");
if (fs.existsSync(ENV_FILE)) {
  const before = { ...process.env };
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    // ignore an unreadable/malformed .env — env vars may still be set
  }
  for (const [k, v] of Object.entries(before)) process.env[k] = v;
}

/* ------------------------------------------------------------------ *
 * Connection profiles
 * ------------------------------------------------------------------ */

const ENVIRONMENTS = ["prod", "stag"];

function profileFor(env) {
  const P = `CLICKHOUSE_${env.toUpperCase()}_`;
  const host = process.env[`${P}HOST`];
  const username = process.env[`${P}USER`] ?? process.env[`${P}USERNAME`] ?? "default";
  const password = process.env[`${P}PASSWORD`] ?? "";

  if (!host) {
    throw new Error(
      `Environment "${env}" is not configured — missing ${P}HOST. ` +
        `Set it in ${ENV_FILE} (see .env.example).`,
    );
  }

  // ClickHouse Cloud is HTTPS on 8443; a self-managed server is usually HTTP on 8123.
  const secure = /^(1|true|yes)$/i.test(process.env[`${P}SECURE`] ?? "true");
  const protocol = secure ? "https" : "http";
  const port = Number(process.env[`${P}PORT`] ?? (secure ? 8443 : 8123));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${P}PORT must be a valid port number (got "${process.env[`${P}PORT`]}")`);
  }

  return {
    url: `${protocol}://${host}:${port}`,
    host,
    port,
    username,
    password,
    database: process.env[`${P}DATABASE`] || process.env[`${P}DB`] || "default",
    requestTimeoutMs: Number(process.env[`${P}TIMEOUT_MS`] ?? 30000),
  };
}

/* ------------------------------------------------------------------ *
 * Layer: SQL guard.
 *
 * ClickHouse has no embeddable parser for JS the way Postgres does, so this is
 * a lexer: comments and string/identifier literals are removed first, which is
 * what keeps `WHERE name = 'drop table'` from being a false positive. It is
 * deliberately a strict allowlist of leading keywords plus a denylist over the
 * stripped text.
 * ------------------------------------------------------------------ */

/** Removes comments and quoted literals, replacing them with a space. */
function stripLiterals(sql) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];

    if (c === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      i++;
      while (i < sql.length) {
        if (sql[i] === "\\") { i += 2; continue; }          // backslash escape
        if (sql[i] === quote && sql[i + 1] === quote) { i += 2; continue; } // doubled quote
        if (sql[i] === quote) { i++; break; }
        i++;
      }
      out += " ";
      continue;
    }
    if (c === "$" && sql.slice(i).startsWith("$$")) {
      // heredoc string: $$ ... $$
      const end = sql.indexOf("$$", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Statements that only read. Anything not starting with one of these is refused.
const ALLOWED_LEADING = /^(select|with|show|describe|desc|explain|exists|check)\b/i;

/**
 * Write verbs, matched anywhere in the stripped statement.
 *
 * Deliberately narrow. Words like `system`, `set` and `kill` are NOT here:
 * `SELECT * FROM system.tables` is read-only and essential, and a `SYSTEM …` /
 * `SET …` / `KILL …` statement is already refused by ALLOWED_LEADING. Adding
 * them would break normal introspection while adding no protection. For the
 * same reason `create` is skipped for SHOW (see below), so `SHOW CREATE TABLE`
 * still works. Note that ClickHouse has no data-modifying CTEs, so a write
 * cannot hide inside a SELECT the way it can in Postgres.
 */
const WRITE_KEYWORDS = new RegExp(
  "\\b(insert|update|delete|alter|create|drop|detach|attach|truncate|rename|" +
    "optimize|grant|revoke|undrop|backup|restore)\\b",
  "i",
);

// Writing query results to a file is a write, whatever the leading keyword is.
const OUTFILE_RE = /\binto\s+outfile\b|\boutfile\b/i;

// Table functions that read from outside this ClickHouse server. `readonly`
// does not block them: a SELECT can still exfiltrate credentials to a URL or
// read local files, so they are refused here.
const BLOCKED_FUNCTIONS = [
  "url", "urlCluster", "file", "fileCluster", "s3", "s3Cluster", "gcs",
  "remote", "remoteSecure", "cluster", "clusterAllReplicas", "mysql", "postgresql",
  "sqlite", "mongodb", "redis", "jdbc", "odbc", "hdfs", "hdfsCluster",
  "azureBlobStorage", "azureBlobStorageCluster", "deltaLake", "iceberg",
  "icebergS3", "hudi", "executable", "input", "s3queue", "kafka",
  "urlWithHeaders", "loadBalancing", "dictionary_source",
];
const BLOCKED_FUNCTION_RE = new RegExp(
  `\\b(${BLOCKED_FUNCTIONS.join("|")})\\s*\\(`,
  "i",
);

// Settings a query must not try to change, even though the server also refuses.
const BLOCKED_SETTINGS = /\b(readonly|allow_ddl|allow_introspection_functions|send_logs_level)\s*=/i;

/**
 * Validates user SQL. Returns the statement kind.
 * Throws with an explanation if it is anything but a single read.
 */
export function assertReadOnlySql(sql) {
  if (!sql || !sql.trim()) throw new Error("Refused: empty query.");

  const stripped = stripLiterals(sql).replace(/\s+/g, " ").trim();
  if (!stripped) throw new Error("Refused: query contains no statement.");

  // ClickHouse rejects multi-statements itself; refuse early with a clear message.
  const withoutTrailing = stripped.replace(/;\s*$/, "");
  if (withoutTrailing.includes(";")) {
    throw new Error("Refused: more than one statement. Send exactly one SELECT.");
  }

  const leading = withoutTrailing.match(ALLOWED_LEADING);
  if (!leading) {
    const firstWord = withoutTrailing.split(/[\s(]/)[0];
    throw new Error(
      `Refused: this server only runs read queries — got "${firstWord}". ` +
        `Allowed: SELECT, WITH, SHOW, DESCRIBE, EXPLAIN, EXISTS, CHECK.`,
    );
  }

  const kind = leading[1].toLowerCase();

  if (OUTFILE_RE.test(withoutTrailing)) {
    throw new Error("Refused: INTO OUTFILE writes to the filesystem.");
  }

  // Every SHOW statement in ClickHouse is read-only, including SHOW CREATE
  // TABLE — so the write-verb scan would only produce false positives there.
  if (kind !== "show") {
    const write = withoutTrailing.match(WRITE_KEYWORDS);
    if (write) {
      throw new Error(
        `Refused: statement contains the keyword "${write[1].toUpperCase()}", which can modify ` +
          `data or schema.`,
      );
    }
  }

  const blockedFn = withoutTrailing.match(BLOCKED_FUNCTION_RE);
  if (blockedFn) {
    throw new Error(
      `Refused: table function ${blockedFn[1]}() reads from outside this ClickHouse server ` +
        `(remote host, object storage, or local filesystem), which read-only mode does not prevent.`,
    );
  }

  if (BLOCKED_SETTINGS.test(withoutTrailing)) {
    throw new Error("Refused: query may not change readonly/DDL-related settings.");
  }

  return { kind };
}

/* ------------------------------------------------------------------ *
 * Client: read-only settings on every request.
 * ------------------------------------------------------------------ */

const MAX_LIMIT = 5000;
const DEFAULT_LIMIT = 200;
const MAX_CELL_CHARS = 4000;

/**
 * `readonly=1`, verified empirically against ClickHouse 26.8:
 *
 *  - readonly=1 blocks the external-reaching table functions (`url()`,
 *    `file()`, `INSERT INTO FUNCTION url(...)`). readonly=2 does NOT — under
 *    readonly=2 those actually execute, so 2 would be strictly weaker.
 *  - readonly=1 also blocks `SET`, which readonly=2 permits.
 *  - Settings sent as request parameters (max_result_rows, max_execution_time,
 *    max_block_size, …) ARE accepted alongside readonly=1 — the restriction
 *    applies to the query changing settings itself, e.g. a `SETTINGS
 *    readonly=0` clause, which always fails with
 *    "Cannot modify 'readonly' setting in readonly mode".
 */
/**
 * How strict the server is about settings under readonly mode varies by
 * deployment, so this is discovered per environment at runtime:
 *   - stag (26.2) accepts resource-limit settings alongside readonly=1;
 *   - prod refuses ALL of them ("Cannot modify 'max_execution_time' setting in
 *     readonly mode"), which is the documented readonly=1 behaviour.
 * `undefined` = not yet known, `false` = send nothing but readonly.
 */
const settingsAccepted = new Map();

const SETTING_REJECTED = /Cannot modify '([^']+)' setting in readonly mode/i;

function readOnlySettings(env, { limit, timeoutMs }) {
  // readonly=1 itself is always accepted: ClickHouse allows raising the
  // restriction, only lowering it is refused.
  if (settingsAccepted.get(env) === false) return { readonly: 1 };
  return {
    readonly: 1,
    // NOTE: never send `allow_ddl`. On some versions it is protected and
    // rejected outright under readonly mode (prod does this, stag does not),
    // and readonly=1 already blocks DDL — so it bought nothing and broke prod.
    max_execution_time: Math.ceil(timeoutMs / 1000),
    max_result_rows: limit + 1,
    // `break` only stops at a block boundary, so without a block-size cap a
    // limit of 200 can still yield a whole ~65k-row block.
    max_block_size: limit + 1,
    result_overflow_mode: "break",
    max_result_bytes: 256 * 1024 * 1024,
  };
}

/**
 * Runs `attempt`, and if the server rejects our settings under readonly mode,
 * records that for this environment and retries once with readonly only. Row
 * and time limits are still enforced client-side, so degrading here is safe.
 */
async function withSettingsFallback(env, attempt) {
  try {
    return await attempt();
  } catch (err) {
    const m = SETTING_REJECTED.exec(err?.message ?? "");
    if (m && settingsAccepted.get(env) !== false) {
      settingsAccepted.set(env, false);
      return await attempt();
    }
    throw err;
  }
}

function withClient(env, database, fn, { limit = MAX_LIMIT, timeoutMs } = {}) {
  return withSettingsFallback(env, async () => {
    const profile = profileFor(env);
    const client = createClient({
      url: profile.url,
      username: profile.username,
      password: profile.password,
      database: database ?? profile.database,
      request_timeout: timeoutMs ?? profile.requestTimeoutMs,
      application: "clickhouse-readonly-mcp",
      clickhouse_settings: readOnlySettings(env, {
        limit,
        timeoutMs: timeoutMs ?? profile.requestTimeoutMs,
      }),
    });
    try {
      return await fn(client, profile);
    } finally {
      await client.close().catch(() => {});
    }
  });
}

/** Runs one of this server's own fixed catalog queries. */
async function catalogQuery(client, query, query_params) {
  const rs = await client.query({ query, query_params, format: "JSON" });
  return await rs.json();
}

/* ------------------------------------------------------------------ *
 * Server + tools
 * ------------------------------------------------------------------ */

const server = new McpServer(
  { name: "clickhouse-readonly-mcp", version: "1.0.0" },
  {
    instructions:
      "Read-only ClickHouse access for the 'prod' and 'stag' environments. Every tool takes an " +
      "`env` parameter that selects which server to query. This server cannot write, modify, or " +
      "delete anything.",
  },
);

const envSchema = z
  .enum(ENVIRONMENTS)
  .describe("Which configured ClickHouse environment to query: 'prod' or 'stag'.");

function ok(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(err) {
  // ClickHouse errors are long and prefixed with a code; keep the useful part.
  const raw = err instanceof Error ? err.message : String(err);
  const trimmed = raw.replace(/\s+/g, " ").slice(0, 900);
  return { isError: true, content: [{ type: "text", text: `Error: ${trimmed}` }] };
}

function clampCell(value) {
  if (typeof value === "string" && value.length > MAX_CELL_CHARS) {
    return `${value.slice(0, MAX_CELL_CHARS)}… [truncated, ${value.length} chars total]`;
  }
  return value;
}

server.registerTool(
  "list_databases",
  {
    title: "List databases",
    description:
      "List all databases on the selected ClickHouse environment (prod or stag), with engine, " +
      "table count, total rows and on-disk size. Read-only.",
    inputSchema: { env: envSchema },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  async ({ env }) => {
    try {
      const out = await withClient(env, undefined, async (client, profile) => {
        const res = await catalogQuery(
          client,
          `SELECT d.name AS name,
                  d.engine AS engine,
                  countIf(t.name != '') AS tables,
                  sum(t.total_rows) AS total_rows,
                  formatReadableSize(sum(t.total_bytes)) AS size
           FROM system.databases AS d
           LEFT JOIN system.tables AS t ON t.database = d.name
           GROUP BY d.name, d.engine
           ORDER BY d.name`,
        );
        return { host: profile.host, port: profile.port, databases: res.data };
      });
      return ok({ env, host: out.host, port: out.port, count: out.databases.length, databases: out.databases });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "list_tables",
  {
    title: "List tables",
    description:
      "List tables in a database on the selected ClickHouse environment (prod or stag), with " +
      "engine, row count, size and sorting key. The sorting key matters for writing efficient " +
      "queries. Read-only.",
    inputSchema: {
      env: envSchema,
      database: z.string().min(1).describe("Database name, as returned by list_databases."),
      include_views: z.boolean().optional().describe("Include views and materialized views. Default false."),
      name_like: z
        .string()
        .min(1)
        .optional()
        .describe("Only tables whose name matches this SQL LIKE pattern, e.g. 'events_%'."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  async ({ env, database, include_views = false, name_like }) => {
    try {
      const out = await withClient(env, undefined, async (client, profile) => {
        const res = await catalogQuery(
          client,
          `SELECT name,
                  engine,
                  total_rows,
                  formatReadableSize(total_bytes) AS size,
                  sorting_key,
                  partition_key
           FROM system.tables
           WHERE database = {db:String}
             AND ({views:UInt8} = 1 OR engine NOT LIKE '%View')
             AND ({pattern:String} = '' OR name LIKE {pattern:String})
           ORDER BY total_bytes DESC, name`,
          { db: database, views: include_views ? 1 : 0, pattern: name_like ?? "" },
        );
        return { host: profile.host, tables: res.data };
      });

      if (out.tables.length === 0) {
        // Distinguish "empty database" from "no such database".
        const dbs = await withClient(env, undefined, async (client) => {
          const res = await catalogQuery(client, "SELECT name FROM system.databases ORDER BY name");
          return res.data.map((r) => r.name);
        });
        if (!dbs.includes(database)) {
          return fail(
            new Error(`Database "${database}" does not exist on ${env}. Available: ${dbs.join(", ")}`),
          );
        }
      }

      return ok({
        env,
        host: out.host,
        database,
        ...(name_like ? { name_like } : {}),
        count: out.tables.length,
        tables: out.tables,
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "run_query",
  {
    title: "Run a read-only query",
    description:
      "Run a single read-only SQL query (SELECT / WITH / SHOW / DESCRIBE / EXPLAIN / EXISTS) " +
      "against the selected ClickHouse environment (prod or stag). The statement is validated " +
      "and executed with ClickHouse's readonly mode enabled, so writes and DDL are impossible. " +
      "Prefer {name:Type} placeholders with `params` over inlining values. Results are capped " +
      "by `limit`; the response says when rows were truncated.",
    inputSchema: {
      env: envSchema,
      sql: z
        .string()
        .min(1)
        .describe("A single read statement. No semicolon-separated statements."),
      database: z
        .string()
        .min(1)
        .optional()
        .describe("Default database for unqualified table names. Defaults to the profile's database."),
      params: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional()
        .describe(
          "Values for {name:Type} placeholders, e.g. sql \"… WHERE id = {id:UInt64}\" with params {\"id\": 42}.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .optional()
        .describe(`Maximum rows to return. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`),
      timeout_ms: z
        .number()
        .int()
        .min(1000)
        .max(120000)
        .optional()
        .describe("Server-side execution timeout for this query. Default 30000."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ env, sql, database, params, limit = DEFAULT_LIMIT, timeout_ms = 30000 }) => {
    try {
      assertReadOnlySql(sql);

      // ClickHouse honours the LAST duplicate setting in a request, so a
      // parameter name able to inject `&readonly=0` would defeat layer 1.
      // The client URL-encodes these, but validate anyway.
      for (const name of Object.keys(params ?? {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          throw new Error(
            `Refused: invalid parameter name "${name}" — use letters, digits and underscores only.`,
          );
        }
      }

      const started = Date.now();
      const out = await withClient(
        env,
        database,
        async (client, profile) => {
          // Streamed, and abandoned as soon as one row past the limit arrives.
          // This is what actually bounds the response: on servers that refuse
          // our max_result_rows/max_block_size (prod), nothing server-side
          // would stop `SELECT * FROM huge_table` from streaming everything.
          const rs = await client.query({
            query: sql,
            query_params: params,
            format: "JSONCompactEachRowWithNamesAndTypes",
            abort_signal: AbortSignal.timeout(timeout_ms),
            clickhouse_settings: readOnlySettings(env, { limit, timeoutMs: timeout_ms }),
          });

          let names = null;
          let types = null;
          const rows = [];
          const stream = rs.stream();
          try {
            outer: for await (const batch of stream) {
              for (const row of batch) {
                const value = row.json();
                if (names === null) { names = value; continue; }
                if (types === null) { types = value; continue; }
                rows.push(value);
                if (rows.length > limit) break outer; // one past the limit
              }
            }
          } finally {
            stream.destroy();
          }

          return {
            names: names ?? [],
            types: types ?? [],
            rows,
            summary: rs.response_headers?.["x-clickhouse-summary"],
            host: profile.host,
            database: database ?? profile.database,
          };
        },
        { limit, timeoutMs: timeout_ms },
      );

      const truncated = out.rows.length > limit;
      if (truncated) out.rows.length = limit;

      let summary = {};
      try {
        if (out.summary) {
          const s = JSON.parse(out.summary);
          summary = { rows_read: Number(s.read_rows), bytes_read: Number(s.read_bytes) };
        }
      } catch {
        /* summary header is a nicety */
      }

      return ok({
        env,
        database: out.database,
        row_count: out.rows.length,
        ...(truncated
          ? {
              truncated: true,
              note: `Only the first ${limit} rows are shown. Raise \`limit\` (max ${MAX_LIMIT}) or add LIMIT to the query.`,
            }
          : { truncated: false }),
        elapsed_ms: Date.now() - started,
        ...summary,
        columns: out.names.map((name, i) => ({ name, type: out.types[i] })),
        // JSONCompactEachRow rows are positional arrays; pair them with names.
        rows: out.rows.map((r) =>
          Object.fromEntries(out.names.map((name, i) => [name, clampCell(r[i])])),
        ),
      });
    } catch (err) {
      // A client-side abort is a timeout; say so instead of "The user aborted a
      // request", which reads like the caller cancelled.
      if (err?.name === "AbortError" || /aborted a request/i.test(err?.message ?? "")) {
        return fail(
          new Error(
            `Query cancelled after timeout_ms=${timeout_ms}. Narrow the query or raise timeout_ms (max 120000).`,
          ),
        );
      }
      return fail(err);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
