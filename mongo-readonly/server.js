#!/usr/bin/env node
/**
 * mongo-readonly-mcp
 *
 * A strictly read-only MCP server for MongoDB, mirroring postgres-readonly-mcp
 * and clickhouse-readonly-mcp.
 *
 * Tools:
 *   - list_databases(env)
 *   - list_collections(env, database, ...)
 *   - describe_collection(env, database, collection, sample_size?)
 *   - find(env, database, collection, filter?, projection?, sort?, ...)
 *   - aggregate(env, database, collection, pipeline, ...)
 *   - count_documents(env, database, collection, filter?)
 *
 * `env` selects a connection profile: "prod" or "stag". Both are configured at
 * the same time via environment variables (see .env.example).
 *
 * MongoDB has no read-only session or transaction to lean on, so read-only is
 * enforced by what this server is able to send at all — see README.md.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MongoClient, BSON } from "mongodb";

const { EJSON } = BSON;

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
 * Connection profiles
 * ------------------------------------------------------------------ */

const ENVIRONMENTS = ["prod", "stag"];
const READ_PREFERENCES = ["primary", "primaryPreferred", "secondary", "secondaryPreferred", "nearest"];

/** Reads MONGO_<ENV>_* variables into a profile. */
function profileFor(env) {
  const P = `MONGO_${env.toUpperCase()}_`;
  const uri = process.env[`${P}URI`];
  if (!uri) {
    throw new Error(
      `Environment "${env}" is not configured — missing ${P}URI. ` +
        `Set it in ${ENV_FILE} (see .env.example).`,
    );
  }
  if (!/^mongodb(\+srv)?:\/\//.test(uri)) {
    throw new Error(`${P}URI must start with mongodb:// or mongodb+srv://`);
  }

  const readPreference = process.env[`${P}READ_PREFERENCE`] || "secondaryPreferred";
  if (!READ_PREFERENCES.includes(readPreference)) {
    throw new Error(
      `${P}READ_PREFERENCE must be one of primary | primaryPreferred | secondary | ` +
        `secondaryPreferred | nearest (got "${readPreference}")`,
    );
  }

  const maxTimeMs = Number(process.env[`${P}MAX_TIME_MS`] ?? 15000);
  if (!Number.isInteger(maxTimeMs) || maxTimeMs <= 0) {
    throw new Error(`${P}MAX_TIME_MS must be a positive integer`);
  }

  // Never surface credentials: report only the host list. URL() can't parse
  // multi-host seed lists or unescaped password characters, so slice by hand:
  // hosts sit after the last "@" (or the scheme) and before the first "/" or "?".
  const afterScheme = uri.replace(/^mongodb(\+srv)?:\/\//, "");
  const hostPart = afterScheme.slice(afterScheme.lastIndexOf("@") + 1).split(/[/?]/)[0];
  const host = hostPart || "(unknown host)";

  return { env, uri, host, readPreference, maxTimeMs };
}

// One pooled client per environment, created on first use. Unlike Postgres,
// there is no per-connection read-only mode to set, so there is nothing to gain
// from a fresh connection per call.
const clients = new Map();

async function clientFor(env) {
  const profile = profileFor(env);
  let entry = clients.get(env);
  if (entry && entry.uri !== profile.uri) {
    await entry.client.close().catch(() => {});
    entry = undefined;
  }
  if (!entry) {
    const client = new MongoClient(profile.uri, {
      appName: "mongo-readonly-mcp",
      readPreference: profile.readPreference,
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      // Reads never need retrying writes; make that explicit.
      retryWrites: false,
    });
    entry = { uri: profile.uri, client, connecting: client.connect() };
    clients.set(env, entry);
  }
  try {
    await entry.connecting;
  } catch (err) {
    clients.delete(env);
    await entry.client.close().catch(() => {});
    throw err;
  }
  return { profile, client: entry.client };
}

/* ------------------------------------------------------------------ *
 * Operator guard.
 *
 * The driver calls this server makes — find, aggregate, countDocuments,
 * listCollections, listIndexes — cannot modify data with one exception:
 * an aggregation pipeline ending in $out or $merge writes its result to a
 * collection. Those are refused wherever they appear, along with server-side
 * JavaScript ($where, $function, $accumulator) and stages that expose other
 * sessions or never return ($currentOp, $changeStream, ...).
 *
 * Every pipeline, including the ones nested in $facet, $lookup and
 * $unionWith, must be built from an allowlist of stages.
 * ------------------------------------------------------------------ */

const ALLOWED_STAGES = new Set([
  "$match", "$project", "$addFields", "$set", "$unset", "$group", "$sort", "$limit",
  "$skip", "$count", "$unwind", "$lookup", "$graphLookup", "$facet", "$bucket",
  "$bucketAuto", "$sortByCount", "$replaceRoot", "$replaceWith", "$sample",
  "$unionWith", "$densify", "$fill", "$setWindowFields", "$redact", "$geoNear",
  "$collStats", "$indexStats", "$search", "$searchMeta", "$vectorSearch", "$documents",
]);

// Refused as a key at any depth, in filters, projections, sorts and pipelines.
const FORBIDDEN_OPERATORS = new Set([
  "$out", "$merge", // write the result to a collection
  "$where", "$function", "$accumulator", // server-side JavaScript
  "$currentOp", "$listSessions", "$listLocalSessions", "$listSampledQueries",
  "$changeStream", "$changeStreamSplitLargeEvent", "$planCacheStats",
  "$shardedDataDistribution", "$queryStats", "$listSearchIndexes",
]);

const MAX_NESTING = 64;

/** Throws if `value` contains a forbidden operator anywhere. */
function assertNoForbiddenOperators(value, where, depth = 0) {
  if (depth > MAX_NESTING) throw new Error(`Refused: ${where} is nested too deeply.`);
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenOperators(item, where, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_OPERATORS.has(key)) {
      throw new Error(`Refused: ${key} is not allowed in ${where} (this server is read-only).`);
    }
    assertNoForbiddenOperators(child, where, depth + 1);
  }
}

/** Checks one pipeline (and the pipelines nested in it) against the stage allowlist. */
function assertReadOnlyPipeline(pipeline, where = "pipeline") {
  if (!Array.isArray(pipeline)) throw new Error(`Refused: ${where} must be an array of stages.`);
  pipeline.forEach((stage, i) => {
    if (!stage || typeof stage !== "object" || Array.isArray(stage)) {
      throw new Error(`Refused: ${where}[${i}] must be an object like {"$match": {...}}.`);
    }
    const keys = Object.keys(stage);
    if (keys.length !== 1) {
      throw new Error(
        `Refused: ${where}[${i}] must have exactly one stage operator (got ${keys.join(", ") || "none"}).`,
      );
    }
    const [name] = keys;
    if (!ALLOWED_STAGES.has(name)) {
      throw new Error(
        `Refused: stage ${name} is not allowed in ${where}[${i}]. Allowed: ${[...ALLOWED_STAGES].join(", ")}.`,
      );
    }
    const body = stage[name];
    if (name === "$facet" && body && typeof body === "object") {
      for (const [facet, sub] of Object.entries(body)) {
        assertReadOnlyPipeline(sub, `${where}[${i}].$facet.${facet}`);
      }
    }
    if ((name === "$lookup" || name === "$unionWith") && Array.isArray(body?.pipeline)) {
      assertReadOnlyPipeline(body.pipeline, `${where}[${i}].${name}.pipeline`);
    }
  });
  assertNoForbiddenOperators(pipeline, where);
}

/**
 * Turns a tool argument into BSON-ready values. Extended JSON wrappers such as
 * {"$oid": "..."} and {"$date": "..."} become ObjectId / Date; plain numbers
 * stay numbers.
 */
function fromExtendedJson(value, where) {
  if (value === undefined) return undefined;
  try {
    return EJSON.deserialize(value, { relaxed: true });
  } catch (err) {
    throw new Error(`${where} is not valid Extended JSON: ${err.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * Identifiers: database and collection names are checked against the
 * server before use. Mongo creates nothing on read, so a typo would
 * otherwise come back as a silent empty result.
 * ------------------------------------------------------------------ */

const DB_NAME_RE = /^[^\/\\. "$*<>:|?\x00]{1,63}$/;

function assertDatabaseName(database) {
  if (!DB_NAME_RE.test(database)) throw new Error(`"${database}" is not a valid database name.`);
}

const collectionCache = new Map();
const COLLECTION_TTL_MS = 60000;

async function collectionNames(client, env, database, { fresh = false } = {}) {
  const key = `${env}/${database}`;
  const cached = collectionCache.get(key);
  if (!fresh && cached && Date.now() - cached.at < COLLECTION_TTL_MS) return cached.names;
  const names = (
    await client.db(database).listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray()
  ).map((c) => c.name);
  collectionCache.set(key, { at: Date.now(), names });
  return names;
}

async function assertCollectionExists(client, env, database, collection) {
  assertDatabaseName(database);
  let names = await collectionNames(client, env, database);
  if (names.includes(collection)) return;
  names = await collectionNames(client, env, database, { fresh: true });
  if (names.includes(collection)) return;
  const visible = names.filter((n) => !n.startsWith("system.")).sort();
  throw new Error(
    visible.length
      ? `Collection "${collection}" does not exist in ${database} on ${env}. ` +
          `Available: ${visible.slice(0, 100).join(", ")}${visible.length > 100 ? ", …" : ""}`
      : `Database "${database}" has no collections on ${env} (or does not exist). Call list_databases.`,
  );
}

/* ------------------------------------------------------------------ *
 * Output shaping
 * ------------------------------------------------------------------ */

const MAX_CELL_CHARS = 4000;
const MAX_RESPONSE_CHARS = 400_000;

/** Relaxed Extended JSON, with long strings and binary payloads clipped. */
function toOutput(doc) {
  const clip = (v) => {
    if (typeof v === "string") {
      return v.length > MAX_CELL_CHARS
        ? `${v.slice(0, MAX_CELL_CHARS)}… [truncated, ${v.length} chars total]`
        : v;
    }
    if (Array.isArray(v)) return v.map(clip);
    if (v && typeof v === "object") {
      if (v.$binary && typeof v.$binary.base64 === "string" && v.$binary.base64.length > 88) {
        return { $binary: { ...v.$binary, base64: `${v.$binary.base64.slice(0, 88)}…` } };
      }
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x)]));
    }
    return v;
  };
  return clip(EJSON.serialize(doc, { relaxed: true }));
}

/** Drops trailing documents until the payload fits in a sensible response. */
function fitDocuments(docs) {
  let size = 0;
  for (let i = 0; i < docs.length; i++) {
    size += JSON.stringify(docs[i]).length;
    if (size > MAX_RESPONSE_CHARS) return { docs: docs.slice(0, Math.max(i, 1)), clipped: true };
  }
  return { docs, clipped: false };
}

function ok(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(err) {
  const msg = err instanceof Error ? err.message : String(err);
  const code = err?.codeName ? ` (${err.codeName})` : "";
  return { isError: true, content: [{ type: "text", text: `Error: ${msg}${code}` }] };
}

/** Reads up to `limit` documents, plus one more to detect truncation. */
async function readCursor(cursor, limit) {
  const docs = [];
  try {
    for await (const doc of cursor) {
      docs.push(doc);
      if (docs.length > limit) break;
    }
  } finally {
    await cursor.close().catch(() => {});
  }
  const truncated = docs.length > limit;
  if (truncated) docs.length = limit;
  return { docs, truncated };
}

/* ------------------------------------------------------------------ *
 * Server + tools
 * ------------------------------------------------------------------ */

const server = new McpServer(
  { name: "mongo-readonly-mcp", version: "1.0.0" },
  {
    instructions:
      "Read-only MongoDB access for the 'prod' and 'stag' environments. Every tool takes an " +
      "`env` parameter that selects which deployment to query. Filters, projections, sorts and " +
      "pipelines are MongoDB Extended JSON: write ObjectIds as {\"$oid\": \"...\"} and dates as " +
      "{\"$date\": \"2026-01-01T00:00:00Z\"}. Call describe_collection to learn a collection's " +
      "fields before querying it. This server cannot write, modify, or delete anything.",
  },
);

const envSchema = z
  .enum(ENVIRONMENTS)
  .describe("Which configured MongoDB environment to query: 'prod' or 'stag'.");
const databaseSchema = z.string().min(1).describe("Database name, as returned by list_databases.");
const collectionSchema = z
  .string()
  .min(1)
  .describe("Collection (or view) name, as returned by list_collections.");
const ejsonObject = (what) =>
  z
    .record(z.string(), z.any())
    .optional()
    .describe(`${what} as an Extended JSON object, e.g. {"_id": {"$oid": "..."}}.`);
const timeoutSchema = z
  .number()
  .int()
  .min(100)
  .max(120000)
  .optional()
  .describe("Server-side time limit (maxTimeMS) for this call. Defaults to the environment's setting.");

const MAX_LIMIT = 2000;
const DEFAULT_LIMIT = 100;

server.registerTool(
  "list_databases",
  {
    title: "List databases",
    description:
      "List the databases on the selected MongoDB environment (prod or stag) with their size on " +
      "disk, and the roles the configured user holds. Read-only.",
    inputSchema: { env: envSchema },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  async ({ env }) => {
    try {
      const { profile, client } = await clientFor(env);
      const admin = client.db("admin").admin();
      // authorizedDatabases lets a user without the listDatabases privilege
      // still see the databases it can read.
      const res = await admin.listDatabases({ authorizedDatabases: true, maxTimeMS: profile.maxTimeMs });
      const databases = res.databases
        .map((d) => ({ name: d.name, size_on_disk: d.sizeOnDisk ?? null, empty: d.empty ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name));

      let roles = null;
      try {
        const status = await client.db("admin").command({ connectionStatus: 1 });
        roles = (status.authInfo?.authenticatedUserRoles ?? []).map((r) => `${r.role}@${r.db}`);
      } catch {
        /* roles are informational only */
      }
      const READ_ROLES = /^(read|readAnyDatabase|clusterMonitor|backup)@/;
      const writeCapable = roles?.filter((r) => !READ_ROLES.test(r)) ?? [];

      return ok({
        env,
        host: profile.host,
        read_preference: profile.readPreference,
        ...(roles ? { user_roles: roles } : {}),
        ...(writeCapable.length
          ? {
              warning:
                `The configured user holds roles beyond read-only (${writeCapable.join(", ")}). ` +
                `This server still refuses writes, but a read-only user is the stronger guarantee.`,
            }
          : {}),
        count: databases.length,
        total_size: res.totalSize ?? null,
        databases,
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "list_collections",
  {
    title: "List collections",
    description:
      "List the collections and views in a database on the selected MongoDB environment, with " +
      "type and an estimated document count. system.* collections are excluded unless " +
      "include_system is true. Read-only.",
    inputSchema: {
      env: envSchema,
      database: databaseSchema,
      name_regex: z
        .string()
        .min(1)
        .optional()
        .describe("Only collections whose name matches this regex, e.g. '^events_'."),
      include_system: z.boolean().optional().describe("Include system.* collections. Default false."),
      with_counts: z
        .boolean()
        .optional()
        .describe("Include estimated document counts (from collection metadata, cheap). Default true."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  async ({ env, database, name_regex, include_system = false, with_counts = true }) => {
    try {
      assertDatabaseName(database);
      const { profile, client } = await clientFor(env);
      const db = client.db(database);
      const filter = name_regex ? { name: { $regex: name_regex } } : {};
      const infos = await db
        .listCollections(filter, { maxTimeMS: profile.maxTimeMs })
        .toArray();

      const collections = await Promise.all(
        infos
          .filter((c) => include_system || !c.name.startsWith("system."))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(async (c) => {
            const out = { name: c.name, type: c.type };
            if (c.type === "view") {
              out.view_on = c.options?.viewOn;
            } else if (c.options?.timeseries) {
              out.timeseries = c.options.timeseries;
            }
            if (c.options?.capped) out.capped = true;
            if (with_counts && c.type !== "view") {
              try {
                out.estimated_count = await db
                  .collection(c.name)
                  .estimatedDocumentCount({ maxTimeMS: profile.maxTimeMs });
              } catch {
                out.estimated_count = null;
              }
            }
            return out;
          }),
      );

      if (!name_regex) {
        collectionCache.set(`${env}/${database}`, { at: Date.now(), names: infos.map((c) => c.name) });
      }

      return ok({
        env,
        host: profile.host,
        database,
        count: collections.length,
        collections,
        ...(collections.length === 0 && !name_regex
          ? { note: `No collections in "${database}" — it may not exist. Call list_databases.` }
          : {}),
      });
    } catch (err) {
      return fail(err);
    }
  },
);

function shortExample(v) {
  if (typeof v === "string") return v.length > 120 ? `${v.slice(0, 120)}… [${v.length} chars]` : v;
  return toOutput({ v }).v;
}

/** Collects field paths and their BSON types across sampled documents. */
function inferSchema(docs, maxDepth = 6) {
  const fields = new Map();
  const typeOf = (v) => {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    if (v instanceof Date) return "date";
    if (v?._bsontype) return v._bsontype.toLowerCase();
    return typeof v === "object" ? "object" : typeof v;
  };
  const note = (p, v) => {
    let f = fields.get(p);
    if (!f) fields.set(p, (f = { count: 0, types: {}, example: undefined }));
    f.count++;
    const t = typeOf(v);
    f.types[t] = (f.types[t] ?? 0) + 1;
    if (f.example === undefined && t !== "null" && t !== "object" && t !== "array") f.example = v;
  };
  const walk = (obj, prefix, depth) => {
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      note(p, v);
      if (depth >= maxDepth) continue;
      const t = typeOf(v);
      if (t === "object") walk(v, p, depth + 1);
      if (t === "array") {
        // Element types go under "<path>[]"; object elements are merged.
        const seen = new Set();
        for (const el of v.slice(0, 50)) {
          const et = typeOf(el);
          if (!seen.has(et)) {
            note(`${p}[]`, el);
            seen.add(et);
          }
          if (et === "object") walk(el, `${p}[]`, depth + 1);
        }
      }
    }
  };
  for (const d of docs) walk(d, "", 0);

  return [...fields.entries()]
    .map(([field, f]) => ({
      field,
      present_in: Number((Math.min(f.count, docs.length) / Math.max(docs.length, 1)).toFixed(3)),
      types: f.types,
      ...(f.example !== undefined ? { example: shortExample(f.example) } : {}),
    }))
    .sort((a, b) => a.field.localeCompare(b.field));
}

server.registerTool(
  "describe_collection",
  {
    title: "Describe a collection",
    description:
      "Describe a collection on the selected MongoDB environment: estimated document count, " +
      "indexes, validator/options, and the field paths seen in a random sample of documents " +
      "with their types, how often each is present, and an example value. Use this before " +
      "writing a query against an unfamiliar collection. Read-only.",
    inputSchema: {
      env: envSchema,
      database: databaseSchema,
      collection: collectionSchema,
      sample_size: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("How many documents to sample for field inference. Default 100, max 1000."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  async ({ env, database, collection, sample_size = 100 }) => {
    try {
      const { profile, client } = await clientFor(env);
      await assertCollectionExists(client, env, database, collection);
      const db = client.db(database);
      const coll = db.collection(collection);
      const opts = { maxTimeMS: profile.maxTimeMs };

      const [info] = await db.listCollections({ name: collection }, opts).toArray();
      const isView = info?.type === "view";

      const [estimated, indexes, sample] = await Promise.all([
        isView ? null : coll.estimatedDocumentCount(opts).catch(() => null),
        isView
          ? []
          : coll
              .listIndexes(opts)
              .toArray()
              .catch(() => []),
        coll.aggregate([{ $sample: { size: sample_size } }], opts).toArray(),
      ]);

      const fields = inferSchema(sample);
      return ok({
        env,
        host: profile.host,
        database,
        collection,
        type: info?.type ?? "collection",
        estimated_count: estimated,
        ...(info?.options && Object.keys(info.options).length ? { options: toOutput(info.options) } : {}),
        indexes: indexes.map((ix) => ({
          name: ix.name,
          key: toOutput(ix.key),
          ...(ix.unique ? { unique: true } : {}),
          ...(ix.sparse ? { sparse: true } : {}),
          ...(ix.expireAfterSeconds != null ? { ttl_seconds: ix.expireAfterSeconds } : {}),
          ...(ix.partialFilterExpression ? { partial: toOutput(ix.partialFilterExpression) } : {}),
        })),
        sampled: sample.length,
        field_count: fields.length,
        fields: fields.slice(0, 500),
        ...(fields.length > 500 ? { note: `Showing 500 of ${fields.length} field paths.` } : {}),
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "find",
  {
    title: "Find documents",
    description:
      "Run a read-only find() on a collection on the selected MongoDB environment. filter, " +
      "projection and sort are Extended JSON objects (ObjectId as {\"$oid\": \"...\"}, dates as " +
      "{\"$date\": \"...\"}). $where and other server-side JavaScript are refused. Results are " +
      "returned as relaxed Extended JSON and capped by `limit`; the response says when they were " +
      "truncated.",
    inputSchema: {
      env: envSchema,
      database: databaseSchema,
      collection: collectionSchema,
      filter: ejsonObject("Query filter"),
      projection: ejsonObject("Projection"),
      sort: ejsonObject("Sort specification, e.g. {\"createdAt\": -1}"),
      skip: z.number().int().min(0).optional().describe("Documents to skip. Default 0."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .optional()
        .describe(`Maximum documents to return. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`),
      timeout_ms: timeoutSchema,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ env, database, collection, filter = {}, projection, sort, skip = 0, limit = DEFAULT_LIMIT, timeout_ms }) => {
    try {
      assertNoForbiddenOperators(filter, "filter");
      assertNoForbiddenOperators(projection, "projection");
      assertNoForbiddenOperators(sort, "sort");
      const { profile, client } = await clientFor(env);
      await assertCollectionExists(client, env, database, collection);

      const started = process.hrtime.bigint();
      const cursor = client
        .db(database)
        .collection(collection)
        .find(fromExtendedJson(filter, "filter"), {
          projection: fromExtendedJson(projection, "projection"),
          sort: fromExtendedJson(sort, "sort"),
          skip,
          limit: limit + 1,
          batchSize: Math.min(limit + 1, 1000),
          maxTimeMS: timeout_ms ?? profile.maxTimeMs,
        });
      const { docs, truncated } = await readCursor(cursor, limit);
      const fitted = fitDocuments(docs.map(toOutput));
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

      return ok({
        env,
        database,
        collection,
        count: fitted.docs.length,
        truncated: truncated || fitted.clipped,
        ...(truncated || fitted.clipped
          ? {
              note: fitted.clipped
                ? `Response size cap reached: only the first ${fitted.docs.length} documents are shown. ` +
                  `Add a projection or lower \`limit\`.`
                : `Only the first ${limit} documents are shown. Raise \`limit\` (max ${MAX_LIMIT}) or use \`skip\`.`,
            }
          : {}),
        elapsed_ms: Math.round(elapsedMs),
        documents: fitted.docs,
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "aggregate",
  {
    title: "Run an aggregation",
    description:
      "Run a read-only aggregation pipeline on a collection on the selected MongoDB environment. " +
      "The pipeline is an array of Extended JSON stages. Only read stages are accepted ($match, " +
      "$group, $project, $lookup, $facet, $unwind, $sort, $limit, $count, $setWindowFields, …); " +
      "$out, $merge, $where, $function and $accumulator are refused, including inside $facet, " +
      "$lookup and $unionWith sub-pipelines. Results are capped by `limit`; the response says when " +
      "they were truncated.",
    inputSchema: {
      env: envSchema,
      database: databaseSchema,
      collection: collectionSchema,
      pipeline: z
        .array(z.record(z.string(), z.any()))
        .describe("Aggregation stages, e.g. [{\"$match\": {...}}, {\"$group\": {...}}]."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .optional()
        .describe(`Maximum result documents to return. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`),
      allow_disk_use: z
        .boolean()
        .optional()
        .describe("Let large $group/$sort stages spill to disk. Default false."),
      timeout_ms: timeoutSchema,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ env, database, collection, pipeline, limit = DEFAULT_LIMIT, allow_disk_use = false, timeout_ms }) => {
    try {
      assertReadOnlyPipeline(pipeline);
      const { profile, client } = await clientFor(env);
      // $documents pipelines run against the database, not a collection.
      const dbLevel = pipeline[0] && Object.keys(pipeline[0])[0] === "$documents";
      if (!dbLevel) await assertCollectionExists(client, env, database, collection);
      else assertDatabaseName(database);

      const opts = {
        allowDiskUse: allow_disk_use,
        batchSize: Math.min(limit + 1, 1000),
        maxTimeMS: timeout_ms ?? profile.maxTimeMs,
      };
      const stages = fromExtendedJson(pipeline, "pipeline");
      const started = process.hrtime.bigint();
      const cursor = dbLevel
        ? client.db(database).aggregate(stages, opts)
        : client.db(database).collection(collection).aggregate(stages, opts);
      const { docs, truncated } = await readCursor(cursor, limit);
      const fitted = fitDocuments(docs.map(toOutput));
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

      return ok({
        env,
        database,
        collection,
        count: fitted.docs.length,
        truncated: truncated || fitted.clipped,
        ...(truncated || fitted.clipped
          ? {
              note: fitted.clipped
                ? `Response size cap reached: only the first ${fitted.docs.length} documents are shown. ` +
                  `Add a $project stage or lower \`limit\`.`
                : `Only the first ${limit} documents are shown. Raise \`limit\` (max ${MAX_LIMIT}) or add $skip/$limit.`,
            }
          : {}),
        elapsed_ms: Math.round(elapsedMs),
        documents: fitted.docs,
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "count_documents",
  {
    title: "Count documents",
    description:
      "Count the documents in a collection that match a filter on the selected MongoDB " +
      "environment. With no filter, `estimated: true` returns the fast metadata-based count " +
      "instead of scanning. Read-only.",
    inputSchema: {
      env: envSchema,
      database: databaseSchema,
      collection: collectionSchema,
      filter: ejsonObject("Query filter"),
      estimated: z
        .boolean()
        .optional()
        .describe("Use the metadata count (fast, approximate; ignores filter). Default false."),
      timeout_ms: timeoutSchema,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ env, database, collection, filter = {}, estimated = false, timeout_ms }) => {
    try {
      assertNoForbiddenOperators(filter, "filter");
      if (estimated && Object.keys(filter).length) {
        throw new Error("`estimated: true` cannot take a filter; drop one or the other.");
      }
      const { profile, client } = await clientFor(env);
      await assertCollectionExists(client, env, database, collection);
      const coll = client.db(database).collection(collection);
      const maxTimeMS = timeout_ms ?? profile.maxTimeMs;

      const started = process.hrtime.bigint();
      const count = estimated
        ? await coll.estimatedDocumentCount({ maxTimeMS })
        : await coll.countDocuments(fromExtendedJson(filter, "filter"), { maxTimeMS });
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

      return ok({ env, database, collection, count, estimated, elapsed_ms: Math.round(elapsedMs) });
    } catch (err) {
      return fail(err);
    }
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await Promise.all([...clients.values()].map((c) => c.client.close().catch(() => {})));
    process.exit(0);
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);
