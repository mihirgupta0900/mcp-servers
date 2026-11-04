# mongo-readonly

A minimal, strictly read-only MCP server that lets Claude Code inspect MongoDB
in **two environments at once**: `prod` and `stag`. Every tool takes an `env`
parameter that picks the connection profile.

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_databases` | `env` | every database with size on disk, plus the roles the configured user holds |
| `list_collections` | `env`, `database`, `name_regex?`, `include_system?`, `with_counts?` | collections and views with type and estimated document count |
| `describe_collection` | `env`, `database`, `collection`, `sample_size?` | estimated count, indexes, options/validator, and the field paths in a random sample with their types, presence ratio and an example value |
| `find` | `env`, `database`, `collection`, `filter?`, `projection?`, `sort?`, `skip?`, `limit?`, `timeout_ms?` | matching documents, count, elapsed ms, and whether the result was truncated |
| `aggregate` | `env`, `database`, `collection`, `pipeline`, `limit?`, `allow_disk_use?`, `timeout_ms?` | pipeline output, same shape as `find` |
| `count_documents` | `env`, `database`, `collection`, `filter?`, `estimated?`, `timeout_ms?` | exact count for a filter, or the fast metadata count |

Example asks:

- "list the databases on stag"
- "what does the `orders` collection in `shop` look like on prod?"
- "on stag, how many users signed up per day last week?"

### Query format

Filters, projections, sorts and pipelines are [Extended JSON](https://www.mongodb.com/docs/manual/reference/mongodb-extended-json/),
so non-JSON types can be written out:

```json
{ "_id": { "$oid": "65f0c0ffee0000000000abcd" },
  "createdAt": { "$gte": { "$date": "2026-01-01T00:00:00Z" } } }
```

Results come back as relaxed Extended JSON, the same notation.

- **Row cap.** `limit` defaults to 100, max 2000. The server reads one document
  past the limit, so it can report `truncated: true` without draining the
  cursor. Strings longer than 4000 chars and large binary values are clipped,
  and a response stops adding documents at about 400 KB.
- **Timeouts.** Every operation carries `maxTimeMS` (the environment default,
  or `timeout_ms` up to 120000), so the server kills slow queries itself.
- **Typos are errors.** Mongo returns an empty result for a collection that
  does not exist; this server checks the name first and lists the real ones.

## Configuration

Credentials live in `.env` next to `server.js` (gitignored, `chmod 600`), so
they stay out of the Claude Code config file. Real environment variables, if
set, override the file.

```
MONGO_PROD_URI="mongodb+srv://user:pass@prod-host/?authSource=admin"
MONGO_STAG_URI="mongodb+srv://user:pass@stag-host/?authSource=admin"
```

Quote the URI: Node's `.env` parser cuts an unquoted value at `#`.

Optional per environment (`MONGO_PROD_*` / `MONGO_STAG_*`):

- `..._READ_PREFERENCE`: `secondaryPreferred` (default, keeps ad-hoc reads off the primary) | `primary` | `primaryPreferred` | `secondary` | `nearest`
- `..._MAX_TIME_MS`: default `15000`

Responses report the host only, never the URI or credentials.

## How read-only is enforced

MongoDB has no read-only session or read-only transaction to lean on the way
Postgres does, so the guarantee comes from what this server is able to send:

1. **A fixed command surface.** The server only calls `find`, `aggregate`,
   `countDocuments`, `estimatedDocumentCount`, `listDatabases`,
   `listCollections`, `listIndexes` and `connectionStatus`. There is no
   `runCommand` passthrough, so `insert`, `update`, `delete`, `drop`,
   `createIndex`, `eval` and the rest are unreachable.
2. **Pipeline stage allowlist.** Of those, only an aggregation can write, via a
   final `$out` or `$merge` stage. Every pipeline, including those nested in
   `$facet`, `$lookup` and `$unionWith`, must use stages from an allowlist of
   read stages, one operator per stage.
3. **Operator denylist at any depth.** Filters, projections, sorts and
   pipelines are walked in full and refused if they contain `$out`, `$merge`,
   server-side JavaScript (`$where`, `$function`, `$accumulator`), or stages
   that expose other sessions or never return (`$currentOp`, `$listSessions`,
   `$changeStream`, ...). Values are not inspected, so
   `{"status": "delete"}` is not a false positive.
4. **Bounded execution.** `maxTimeMS` on every operation, `retryWrites=false`,
   and reads routed to secondaries by default.

Tested against a real `mongod` 8: `$out`, `$merge`, both hidden in `$facet`,
`$lookup` and `$unionWith` sub-pipelines, `$function`, `$where` in `find` and
`count_documents`, `$currentOp`, `$changeStream`, and a stage object carrying a
second `$out` key are all refused, and the collections and data are unchanged
afterwards.

For defence in depth, still point this at a MongoDB user that only has the
`read` role (or `readAnyDatabase`). `list_databases` reports the user's roles
and adds a `warning` when any of them grants more than reading.

## Registered with Claude Code

```bash
claude mcp add mongo-readonly --scope user -- /absolute/path/to/mcp-servers/mongo-readonly/run.sh
```

`run.sh` resolves node from nvm, since Claude Code spawns MCP servers with a
minimal `PATH`.

## Local check

```bash
/absolute/path/to/mcp-servers/mongo-readonly/run.sh
```

It should start and wait on stdin (that is the MCP stdio transport). Ctrl-C to exit.
