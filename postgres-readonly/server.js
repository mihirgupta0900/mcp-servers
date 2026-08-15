#!/usr/bin/env node
/**
 * postgres-readonly-mcp
 *
 * A deliberately tiny, read-only MCP server for Postgres.
 *
 * Tools:
 *   - list_databases(env)
 *   - list_tables(env, database, schema?)
 *   - run_query(env, database, sql, ...)
 *
 * `env` selects a connection profile: "prod" or "stag". Both are configured
 * at the same time via environment variables (see .env.example).
 *
 * Read-only is enforced in four independent layers — see README.md.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pg from "pg";
import Cursor from "pg-cursor";
import { parse as parseSql, loadModule as loadParser } from "libpg-query";

// int8 arrives as a string from pg; hand back a number when it fits exactly,
// and keep the string when it would lose precision.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : v;
});

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Load <server dir>/.env if present, so credentials live in one file instead
// of being pasted into the Claude Code MCP config. Real environment variables
// always win over the file.
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
 * Layer 1: no free-form SQL reaches the database.
 * Every statement this server can run is listed here, and each one is
 * checked against a write-verb denylist before it is sent.
 * ------------------------------------------------------------------ */

const FORBIDDEN = new RegExp(
  "\\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|comment|" +
    "copy|merge|call|do|vacuum|analyze|cluster|reindex|refresh|lock|" +
    "checkpoint|import|security\\s+label)\\b|;",
  "i",
);

/** Throws unless `sql` is a single SELECT/WITH statement with no write verbs. */
function assertReadOnlySql(sql) {
  const normalized = sql.replace(/\s+/g, " ").trim();
  if (!/^(select|with)\b/i.test(normalized)) {
    throw new Error(`Refused: only SELECT statements are allowed (got: ${normalized.slice(0, 40)}…)`);
  }
  if (FORBIDDEN.test(normalized)) {
    throw new Error("Refused: statement contains a write verb or statement separator.");
  }
  return normalized;
}

/* ------------------------------------------------------------------ *
 * Guard for user-supplied SQL (run_query).
 *
 * The regex above is fine for the fixed queries in this file, but it is the
 * wrong tool for arbitrary SQL: it would reject `WHERE status = 'delete'` and
 * accept `WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d`, which
 * Postgres parses as a top-level SELECT. So user SQL goes through the real
 * PostgreSQL parser (libpg-query) and is checked structurally.
 * ------------------------------------------------------------------ */

// Statement node types that read data. Everything else is refused.
const ALLOWED_STMT_TYPES = new Set(["SelectStmt", "ExplainStmt", "VariableShowStmt"]);

// Node types that write, wherever they appear in the tree (CTEs, sublinks…).
const WRITE_NODE_TYPES = new Set([
  "InsertStmt", "UpdateStmt", "DeleteStmt", "MergeStmt", "CopyStmt",
  "CreateStmt", "CreateTableAsStmt", "DropStmt", "AlterTableStmt", "TruncateStmt",
  "GrantStmt", "GrantRoleStmt", "IndexStmt", "ViewStmt", "RuleStmt",
  "CreateFunctionStmt", "CreateTrigStmt", "CreateRoleStmt", "AlterRoleStmt",
  "DropRoleStmt", "CreateSeqStmt", "AlterSeqStmt", "CreateSchemaStmt",
  "CreatedbStmt", "DropdbStmt", "AlterDatabaseStmt", "VacuumStmt", "ClusterStmt",
  "ReindexStmt", "RefreshMatViewStmt", "LockStmt", "TransactionStmt",
  "DoStmt", "CallStmt", "CreateExtensionStmt", "AlterExtensionStmt",
  "SecLabelStmt", "CommentStmt", "CreatePolicyStmt", "AlterPolicyStmt",
  "CreateSubscriptionStmt", "CreatePublicationStmt", "AlterSystemStmt",
  "CheckPointStmt", "PrepareStmt", "ExecuteStmt", "DeallocateStmt",
  "DeclareCursorStmt", "FetchStmt", "ClosePortalStmt", "ListenStmt",
  "NotifyStmt", "UnlistenStmt", "CreateForeignTableStmt", "ImportForeignSchemaStmt",
]);

// Functions that reach outside the read-only transaction (writes to other
// sessions/servers/the filesystem, or process control). The read-only
// transaction cannot stop these, so the parser must.
const BLOCKED_FUNCTIONS = new Set([
  "dblink", "dblink_exec", "dblink_open", "dblink_send_query", "dblink_connect",
  "pg_read_file", "pg_read_binary_file", "pg_ls_dir", "pg_stat_file",
  "lo_import", "lo_export", "lo_create", "lo_unlink", "lo_put", "lo_from_bytea",
  "pg_terminate_backend", "pg_cancel_backend", "pg_reload_conf", "pg_rotate_logfile",
  "pg_promote", "pg_create_restore_point", "pg_switch_wal", "pg_logical_emit_message",
  "pg_replication_origin_create", "pg_replication_origin_drop",
  "pg_create_physical_replication_slot", "pg_drop_replication_slot",
  "pg_create_logical_replication_slot", "set_config", "pg_advisory_lock",
  "pg_advisory_lock_shared", "pg_advisory_xact_lock", "query_to_xml",
  "pg_file_write", "pg_file_unlink", "pg_file_rename", "pg_execute_server_program",
]);

/** Depth-first walk of the raw parse tree, yielding [nodeType, nodeValue]. */
function* walkNodes(node) {
  if (Array.isArray(node)) {
    for (const item of node) yield* walkNodes(item);
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (value && typeof value === "object") yield [key, value];
    yield* walkNodes(value);
  }
}

/** Extracts a dotted function name from a FuncCall node. */
function funcCallName(funcCall) {
  const parts = (funcCall?.funcname ?? [])
    .map((p) => p?.String?.sval ?? p?.String?.str)
    .filter(Boolean);
  return parts.join(".").toLowerCase();
}

/**
 * Validates user SQL. Returns { kind: "select" | "explain" | "show" }.
 * Throws with an explanation if the statement is anything but a single read.
 */
export async function assertReadOnlyUserSql(sql) {
  if (!sql || !sql.trim()) throw new Error("Refused: empty query.");

  let tree;
  try {
    tree = await parseSql(sql);
  } catch (err) {
    throw new Error(`SQL could not be parsed: ${err.message}`);
  }

  const stmts = tree?.stmts ?? [];
  if (stmts.length === 0) throw new Error("Refused: no statement found.");
  if (stmts.length > 1) {
    throw new Error(
      `Refused: ${stmts.length} statements in one call. Send exactly one SELECT.`,
    );
  }

  const stmtType = Object.keys(stmts[0].stmt ?? {})[0];
  if (!ALLOWED_STMT_TYPES.has(stmtType)) {
    throw new Error(
      `Refused: this server only runs read queries — got ${stmtType ?? "an unknown statement"}. ` +
        `Allowed: SELECT, EXPLAIN, SHOW.`,
    );
  }

  // EXPLAIN ANALYZE actually runs the statement, so only allow it to wrap a read.
  if (stmtType === "ExplainStmt") {
    const inner = Object.keys(stmts[0].stmt.ExplainStmt?.query ?? {})[0];
    if (inner !== "SelectStmt") {
      throw new Error(`Refused: EXPLAIN may only wrap a SELECT (got ${inner ?? "nothing"}).`);
    }
  }

  // A data-modifying CTE parses as a top-level SelectStmt, so scan the whole tree.
  for (const [nodeType, value] of walkNodes(stmts[0].stmt)) {
    if (WRITE_NODE_TYPES.has(nodeType)) {
      throw new Error(
        `Refused: query contains a ${nodeType} (a write hidden inside the statement, ` +
          `e.g. a data-modifying CTE).`,
      );
    }
    if (nodeType === "FuncCall") {
      const name = funcCallName(value);
      const bare = name.includes(".") ? name.split(".").pop() : name;
      if (BLOCKED_FUNCTIONS.has(name) || BLOCKED_FUNCTIONS.has(bare)) {
        throw new Error(`Refused: function ${name}() can act outside the read-only transaction.`);
      }
    }
  }

  return { kind: stmtType === "SelectStmt" ? "select" : stmtType === "ExplainStmt" ? "explain" : "show" };
}

/* ------------------------------------------------------------------ *
 * Connection profiles
 * ------------------------------------------------------------------ */

const ENVIRONMENTS = ["prod", "stag"];

function sslConfig(mode, caPath) {
  switch ((mode || "require").toLowerCase()) {
    case "disable":
    case "off":
    case "false":
      return false;
    case "require":
      // Same semantics as libpq sslmode=require: encrypt, don't verify the cert.
      return { rejectUnauthorized: false };
    case "verify-full":
    case "verify":
      return {
        rejectUnauthorized: true,
        ...(caPath ? { ca: fs.readFileSync(caPath, "utf8") } : {}),
      };
    default:
      throw new Error(`Unknown SSL mode "${mode}" (use disable | require | verify-full)`);
  }
}

/** Reads PG_<ENV>_* variables into a pg client config. */
function profileFor(env) {
  const P = `PG_${env.toUpperCase()}_`;
  const host = process.env[`${P}HOST`];
  const user = process.env[`${P}USER`];
  const password = process.env[`${P}PASSWORD`];
  const port = Number(process.env[`${P}PORT`] ?? 5432);

  const missing = [
    ["HOST", host],
    ["USER", user],
    ["PASSWORD", password],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => `${P}${k}`);

  if (missing.length) {
    throw new Error(
      `Environment "${env}" is not configured — missing ${missing.join(", ")}. ` +
        `Set them in ${ENV_FILE} (see .env.example).`,
    );
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${P}PORT must be a valid port number (got "${process.env[`${P}PORT`]}")`);
  }

  return {
    host,
    port,
    user,
    password,
    adminDatabase: process.env[`${P}DATABASE`] || "postgres",
    ssl: sslConfig(process.env[`${P}SSL`], process.env[`${P}SSL_CA`]),
    statementTimeoutMs: Number(process.env[`${P}STATEMENT_TIMEOUT_MS`] ?? 15000),
    // Some connection poolers (e.g. PgBouncer in transaction mode) reject
    // startup `options`. Set PG_<ENV>_NO_STARTUP_OPTIONS=1 to skip them; the
    // READ ONLY transaction still applies.
    noStartupOptions: /^(1|true|yes)$/i.test(process.env[`${P}NO_STARTUP_OPTIONS`] ?? ""),
  };
}

/* ------------------------------------------------------------------ *
 * Layer 2 + 3: read-only session, read-only transaction.
 * ------------------------------------------------------------------ */

async function withReadOnlyClient(env, database, fn) {
  const profile = profileFor(env);
  const client = new pg.Client({
    host: profile.host,
    port: profile.port,
    user: profile.user,
    password: profile.password,
    database,
    ssl: profile.ssl,
    application_name: "postgres-readonly-mcp",
    connectionTimeoutMillis: 10000,
    // Layer 2: the backend itself refuses writes for the whole session.
    ...(profile.noStartupOptions
      ? {}
      : {
          options: [
            "-c default_transaction_read_only=on",
            `-c statement_timeout=${profile.statementTimeoutMs}`,
            "-c idle_in_transaction_session_timeout=30000",
          ].join(" "),
        }),
  });

  await client.connect();
  try {
    // Layer 3: an explicit READ ONLY transaction around every query.
    await client.query("BEGIN TRANSACTION READ ONLY");
    // `q` is the guarded path for this file's own fixed queries; `client` is
    // handed to run_query, whose SQL has already been validated by the parser.
    const result = await fn((sql, params) => client.query(assertReadOnlySql(sql), params), client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* connection may already be gone */
    }
    throw err;
  } finally {
    await client.end().catch(() => {});
  }
}

/* ------------------------------------------------------------------ *
 * Layer 4: identifiers are validated against the catalog, never
 * interpolated from raw user input.
 * ------------------------------------------------------------------ */

// run_query validates the database name on every call; cache the catalog
// lookup briefly so that stays one round trip instead of a second connection.
const dbListCache = new Map();
const DB_LIST_TTL_MS = 60000;

async function assertDatabaseExists(env, database) {
  const cached = dbListCache.get(env);
  if (cached && Date.now() - cached.at < DB_LIST_TTL_MS) {
    if (cached.rows.some((r) => r.datname === database)) return;
    dbListCache.delete(env); // unknown name — re-check in case it is new
  }

  const profile = profileFor(env);
  const names = await withReadOnlyClient(env, profile.adminDatabase, async (q) => {
    const { rows } = await q(
      `SELECT datname, datistemplate FROM pg_catalog.pg_database
       WHERE datallowconn ORDER BY datname`,
    );
    return rows;
  });
  dbListCache.set(env, { at: Date.now(), rows: names });
  if (!names.some((r) => r.datname === database)) {
    const suggestions = names.filter((r) => !r.datistemplate).map((r) => r.datname);
    throw new Error(
      `Database "${database}" does not exist on ${env}. Available: ${suggestions.join(", ")}`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Server + tools
 * ------------------------------------------------------------------ */

const server = new McpServer(
  { name: "postgres-readonly-mcp", version: "1.0.0" },
  {
    instructions:
      "Read-only Postgres inspection for the 'prod' and 'stag' environments. " +
      "Every tool takes an `env` parameter that selects which server to query. " +
      "This server cannot write, modify, or delete anything.",
  },
);

const envSchema = z
  .enum(ENVIRONMENTS)
  .describe("Which configured Postgres environment to query: 'prod' or 'stag'.");

function ok(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(err) {
  return {
    isError: true,
    content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
  };
}

server.registerTool(
  "list_databases",
  {
    title: "List databases",
    description:
      "List all databases on the selected Postgres environment (prod or stag), with owner, " +
      "encoding and on-disk size. Read-only.",
    inputSchema: { env: envSchema },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  async ({ env }) => {
    try {
      const profile = profileFor(env);
      const databases = await withReadOnlyClient(env, profile.adminDatabase, async (q) => {
        const { rows } = await q(`
          SELECT d.datname                                        AS name,
                 pg_catalog.pg_get_userbyid(d.datdba)             AS owner,
                 pg_catalog.pg_encoding_to_char(d.encoding)       AS encoding,
                 d.datallowconn                                   AS connectable,
                 CASE WHEN has_database_privilege(d.datname, 'CONNECT')
                      THEN pg_catalog.pg_size_pretty(pg_catalog.pg_database_size(d.datname))
                 END                                              AS size
          FROM pg_catalog.pg_database d
          WHERE NOT d.datistemplate
          ORDER BY d.datname
        `);
        return rows;
      });
      return ok({ env, host: profile.host, port: profile.port, count: databases.length, databases });
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
      "List all tables (and optionally views) inside a database on the selected Postgres " +
      "environment (prod or stag). System schemas are excluded unless include_system is true. " +
      "Read-only.",
    inputSchema: {
      env: envSchema,
      database: z.string().min(1).describe("Database name, as returned by list_databases."),
      schema: z
        .string()
        .min(1)
        .optional()
        .describe("Restrict to a single schema, e.g. 'public'. Omit for all non-system schemas."),
      include_views: z.boolean().optional().describe("Include views and materialized views. Default false."),
      include_system: z
        .boolean()
        .optional()
        .describe("Include pg_catalog / information_schema objects. Default false."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  async ({ env, database, schema, include_views = false, include_system = false }) => {
    try {
      const profile = profileFor(env);
      await assertDatabaseExists(env, database);

      const kinds = include_views ? ["r", "p", "v", "m", "f"] : ["r", "p", "f"];

      const tables = await withReadOnlyClient(env, database, async (q) => {
        const { rows } = await q(
          `
          SELECT n.nspname                                           AS schema,
                 c.relname                                           AS name,
                 CASE c.relkind
                   WHEN 'r' THEN 'table'
                   WHEN 'p' THEN 'partitioned table'
                   WHEN 'v' THEN 'view'
                   WHEN 'm' THEN 'materialized view'
                   WHEN 'f' THEN 'foreign table'
                 END                                                 AS type,
                 pg_catalog.pg_get_userbyid(c.relowner)              AS owner,
                 pg_catalog.pg_size_pretty(
                   pg_catalog.pg_total_relation_size(c.oid))         AS total_size,
                 CASE WHEN c.reltuples < 0 THEN NULL
                      ELSE c.reltuples::bigint END                   AS approx_rows
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind = ANY($1::char[])
            AND ($2::boolean OR (n.nspname NOT IN ('pg_catalog', 'information_schema')
                                 AND n.nspname NOT LIKE 'pg\\_toast%'
                                 AND n.nspname NOT LIKE 'pg\\_temp%'))
            AND ($3::text IS NULL OR n.nspname = $3::text)
          ORDER BY n.nspname, c.relname
        `,
          [kinds, include_system, schema ?? null],
        );
        // bigint comes back as a string from pg; surface a plain number.
        return rows.map((r) => ({
          ...r,
          approx_rows: r.approx_rows == null ? null : Number(r.approx_rows),
        }));
      });

      if (schema && tables.length === 0) {
        const schemas = await withReadOnlyClient(env, database, async (q) => {
          const { rows } = await q(
            `SELECT nspname FROM pg_catalog.pg_namespace
             WHERE nspname NOT IN ('pg_catalog','information_schema')
               AND nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp%'
             ORDER BY nspname`,
          );
          return rows.map((r) => r.nspname);
        });
        return ok({
          env,
          database,
          schema,
          count: 0,
          tables: [],
          note: `No tables found in schema "${schema}". Schemas in this database: ${schemas.join(", ") || "(none)"}`,
        });
      }

      return ok({
        env,
        host: profile.host,
        database,
        ...(schema ? { schema } : {}),
        count: tables.length,
        tables,
      });
    } catch (err) {
      return fail(err);
    }
  },
);

const MAX_LIMIT = 5000;
const DEFAULT_LIMIT = 200;
const MAX_CELL_CHARS = 4000;

/** Keeps a single huge value from swamping the response. */
function clampCell(value) {
  if (typeof value === "string" && value.length > MAX_CELL_CHARS) {
    return `${value.slice(0, MAX_CELL_CHARS)}… [truncated, ${value.length} chars total]`;
  }
  if (Buffer.isBuffer(value)) {
    return `\\x${value.subarray(0, 64).toString("hex")}${value.length > 64 ? "…" : ""}`;
  }
  return value;
}

/** Resolves column type OIDs to readable type names. */
async function describeColumns(q, fields) {
  if (!fields?.length) return [];
  const oids = [...new Set(fields.map((f) => f.dataTypeID))];
  let names = new Map();
  try {
    const { rows } = await q(
      "SELECT oid, typname FROM pg_catalog.pg_type WHERE oid = ANY($1::oid[])",
      [oids],
    );
    names = new Map(rows.map((r) => [Number(r.oid), r.typname]));
  } catch {
    /* type names are a nicety, not a requirement */
  }
  return fields.map((f) => ({ name: f.name, type: names.get(f.dataTypeID) ?? `oid:${f.dataTypeID}` }));
}

server.registerTool(
  "run_query",
  {
    title: "Run a read-only query",
    description:
      "Run a single read-only SQL query (SELECT, EXPLAIN, or SHOW) against a database on the " +
      "selected environment (prod or stag). The statement is checked with the real PostgreSQL " +
      "parser and executed inside a READ ONLY transaction, so writes are impossible. " +
      "Use $1, $2… placeholders with `params` rather than string-concatenating values. " +
      "Results are capped by `limit`; the response says when rows were truncated.",
    inputSchema: {
      env: envSchema,
      database: z.string().min(1).describe("Database to run against, as returned by list_databases."),
      sql: z
        .string()
        .min(1)
        .describe("A single SELECT / EXPLAIN / SHOW statement. No semicolon-separated statements."),
      params: z
        .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional()
        .describe("Values bound to $1, $2, … in the query."),
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
        .min(100)
        .max(120000)
        .optional()
        .describe("Statement timeout for this query. Defaults to the environment's setting."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ env, database, sql, params = [], limit = DEFAULT_LIMIT, timeout_ms }) => {
    try {
      const { kind } = await assertReadOnlyUserSql(sql);
      await assertDatabaseExists(env, database);

      const started = process.hrtime.bigint();
      const out = await withReadOnlyClient(env, database, async (q, client) => {
        if (timeout_ms) {
          // Integer-validated by the schema above, and SET LOCAL dies with the transaction.
          await client.query(`SET LOCAL statement_timeout = ${Math.trunc(timeout_ms)}`);
        }

        if (kind !== "select") {
          // EXPLAIN / SHOW output is small; no cursor needed.
          const res = await client.query(sql, params);
          return {
            columns: await describeColumns(q, res.fields),
            rows: res.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, clampCell(v)]))),
            truncated: false,
          };
        }

        // Cursor: fetch one extra row to detect truncation without reading the
        // whole result set into memory. Also forces the extended query
        // protocol, which cannot carry a second statement.
        const cursor = client.query(new Cursor(sql, params));
        let rows, fields;
        try {
          ({ rows, fields } = await new Promise((resolve, reject) => {
            cursor.read(limit + 1, (err, r, result) =>
              err ? reject(err) : resolve({ rows: r, fields: result?.fields ?? [] }),
            );
          }));
        } finally {
          // Must close before running anything else on this client — the open
          // cursor owns the connection and later queries would queue behind it.
          await cursor.close().catch(() => {});
        }

        const truncated = rows.length > limit;
        if (truncated) rows.length = limit;
        return {
          columns: await describeColumns(q, fields),
          rows: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, clampCell(v)]))),
          truncated,
        };
      });

      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      return ok({
        env,
        database,
        row_count: out.rows.length,
        ...(out.truncated
          ? { truncated: true, note: `Only the first ${limit} rows are shown. Raise \`limit\` (max ${MAX_LIMIT}) or add LIMIT/OFFSET to the query.` }
          : { truncated: false }),
        elapsed_ms: Math.round(elapsedMs),
        columns: out.columns,
        rows: out.rows,
      });
    } catch (err) {
      // Postgres errors carry position/hint info that makes a retry much easier.
      const detail = [
        err?.message,
        err?.hint ? `Hint: ${err.hint}` : null,
        err?.position ? `Position: ${err.position}` : null,
      ]
        .filter(Boolean)
        .join(" | ");
      return fail(new Error(detail || String(err)));
    }
  },
);

await loadParser();

const transport = new StdioServerTransport();
await server.connect(transport);
