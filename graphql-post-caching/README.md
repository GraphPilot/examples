# GraphQL POST response caching

A runnable, dependency-light example of caching GraphQL `POST` responses with a small in-memory
cache in front of a GraphQL origin. It accompanies the GraphPilot blog article
**"How to Cache GraphQL POST Requests: A Practical Guide"**.

The example shows what a GraphQL-aware cache has to get right, and where a hand-written cache
reaches its limits:

- deterministic cache keys from the parsed operation, its variables and the request context
- cache HIT, MISS and BYPASS, visible in response headers
- TTL expiration and a bounded number of entries
- stale responses, and invalidation after a mutation
- bypassing authenticated requests, mutations, introspection and error responses
- the HTTP `QUERY` method ([RFC 10008](https://www.rfc-editor.org/rfc/rfc10008)) next to `POST`

> [!WARNING]
> This is educational code, not a production-ready cache. It keeps everything in the memory of
> one process, loses it on restart, and is not shared between instances. See
> [Limitations](#limitations).

No GraphPilot account is needed. Everything runs locally.

## Contents

- [Quick start](#quick-start)
- [Architecture](#architecture)
- [The Book API](#the-book-api)
- [Walkthrough](#walkthrough)
- [How the cache decides](#how-the-cache-decides)
- [Mutation-based invalidation](#mutation-based-invalidation)
- [GET, POST and QUERY](#get-post-and-query)
- [Configuration](#configuration)
- [Tests](#tests)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Where a managed GraphQL edge cache fits](#where-a-managed-graphql-edge-cache-fits)

## Quick start

Requirements: Node.js 22.15 or newer (GraphQL Yoga 6 requires it), npm, and `curl` for the
walkthrough script.

```bash
cd graphql-post-caching
npm install
npm start
```

```text
Cache proxy:    http://127.0.0.1:4000/graphql   (send requests here)
GraphQL origin: http://127.0.0.1:4001/graphql   (bypasses the cache)
Cache stats:    http://127.0.0.1:4000/_cache/stats
TTL 30s, max 100 entries, origin delay 0ms. Ctrl+C to stop.
```

In a second terminal, send the first request twice:

```bash
curl -i http://127.0.0.1:4000/graphql \
  -H 'content-type: application/json' \
  --data '{"query":"{ books { id title author } }"}'
```

The first response carries `x-cache: MISS`, the second `x-cache: HIT`.

To run every scenario of this README in order:

```bash
npm run demo
```

The demo changes book 1, so start it against a freshly started server. To watch an entry expire
during the demo, start the server with a short TTL: `CACHE_TTL_SECONDS=5 npm start`.

## Architecture

```text
                       ┌─────────────────────────── one Node.js process ───────────────────────────┐
                       │                                                                           │
  client ── POST ────► │  cache proxy :4000  ── POST ──►  GraphQL origin :4001 (GraphQL Yoga)      │
          ◄─ x-cache ─ │   │                                                                       │
                       │   └─ in-memory store: bounded LRU, TTL, entity tags                       │
                       └───────────────────────────────────────────────────────────────────────────┘
```

- **The origin** (`src/schema.js`, `src/origin.js`) is a plain GraphQL Yoga server with an
  in-memory list of books. It knows nothing about caching.
- **The cache proxy** (`src/cache/`) receives every client request, decides HIT, MISS or BYPASS,
  and forwards to the origin when needed. It uses the origin's schema to parse and validate
  operations and to understand responses.
- The origin is also reachable directly on port 4001. The walkthrough uses that to change data
  behind the cache's back and produce a stale response.

| File | Responsibility |
| --- | --- |
| `src/schema.js` | Book schema and resolvers |
| `src/data.js` | In-memory book store (seed data) |
| `src/origin.js` | GraphQL Yoga origin |
| `src/cache/handler.js` | The caching proxy: HIT, MISS, BYPASS, invalidation, diagnostics |
| `src/cache/analyze.js` | Parses the request and decides whether the operation is cacheable |
| `src/cache/policy.js` | Allowlist of public fields, optional per-field `maxAge` |
| `src/cache/key.js` | Deterministic cache keys |
| `src/cache/entities.js` | Finds `Book` objects in a response, for tagging and invalidation |
| `src/cache/store.js` | Bounded LRU store with TTL and tag index |
| `src/http.js`, `src/server.js` | node:http wiring, starts both servers |
| `examples/` | `curl-walkthrough.sh` and `requests.http` |
| `test/` | Automated tests (`node:test`) |

## The Book API

```graphql
type Book {
  id: ID!
  title: String!
  author: String!
  category: String!
  "Price in cents"
  price: Int!
}

type Query {
  books(category: String): [Book!]!
  book(id: ID!): Book
}

type Mutation {
  updateBook(id: ID!, title: String!): Book!
}
```

The seed data is the bookshop used in the GraphPilot demo videos:

| id | title | author | category |
| --- | --- | --- | --- |
| 1 | The Pragmatic Programmer | Hunt & Thomas | software |
| 2 | Designing Data-Intensive Applications | Martin Kleppmann | software |
| 3 | Clean Architecture | Robert C. Martin | software |
| 4 | Dune | Frank Herbert | scifi |

The data lives in memory. Restart the server to reset it.

## Walkthrough

Every step below is part of `npm run demo`. The outputs are from a real run; cache keys depend on
host, path, operation and variables, so yours match as long as you use `127.0.0.1:4000`.

The requests use these shell variables:

```bash
PROXY=http://127.0.0.1:4000/graphql
ORIGIN=http://127.0.0.1:4001/graphql
BOOKS='{"query":"{ books { id title author } }"}'
UPDATE='{"query":"mutation { updateBook(id: \"1\", title: \"Updated Book Title\") { id title } }"}'
```

### 1. First request: MISS

```bash
curl -i $PROXY -H 'content-type: application/json' --data "$BOOKS"
```

```text
HTTP/1.1 200 OK
x-cache: MISS
x-cache-key: 675f6a613dfae44c
x-cache-ttl: 30

{"data":{"books":[{"id":"1","title":"The Pragmatic Programmer","author":"Hunt & Thomas"}, ...]}}
```

The origin answered, and the response was stored for 30 seconds.

### 2. Identical second request: HIT

Run the same command again:

```text
HTTP/1.1 200 OK
age: 0
x-cache: HIT
x-cache-key: 675f6a613dfae44c
x-cache-ttl: 30
```

The origin was not called. `age` is the entry's age in seconds, `x-cache-ttl` the remaining
freshness. Reformatting the query (whitespace, comments) still hits the same entry, because the
key is built from the parsed and re-printed operation, not from the raw string.

### 3. Different variables: separate entries

```bash
curl -i $PROXY -H 'content-type: application/json' \
  --data '{"query":"query Book($id: ID!) { book(id: $id) { id title author } }","variables":{"id":"1"}}'
curl -i $PROXY -H 'content-type: application/json' \
  --data '{"query":"query Book($id: ID!) { book(id: $id) { id title author } }","variables":{"id":"2"}}'
```

Both are a `MISS` with different keys (`42a458bf276c3cb1` and `c48b63a3191b2e7e`). Repeating the
first one is a `HIT`. Variable key order does not matter, and `{"id": 1}` and `{"id": "1"}` share
an entry, because variables are coerced against the schema before they go into the key.

### 4. Authenticated request: BYPASS

```bash
curl -i $PROXY -H 'content-type: application/json' \
  -H 'authorization: Bearer demo-token-alice' --data "$BOOKS"
```

```text
HTTP/1.1 200 OK
x-cache: BYPASS
x-cache-reason: authenticated
```

Any request with an `Authorization` or `Cookie` header goes to the origin and its response is
never stored, even if the origin returns the same data to everyone. `demo-token-alice` is a fake
value for the demo, not a credential.

### 5. Stale data: change a book behind the cache's back

Send the mutation **directly to the origin** on port 4001, so the cache never sees it:

```bash
curl -i $ORIGIN -H 'content-type: application/json' --data "$UPDATE"
```

```text
{"data":{"updateBook":{"id":"1","title":"Updated Book Title"}}}
```

Then ask the cache:

```bash
curl -i $PROXY -H 'content-type: application/json' --data "$BOOKS"
```

```text
HTTP/1.1 200 OK
x-cache: HIT
{"data":{"books":[{"id":"1","title":"The Pragmatic Programmer", ...
```

A `HIT` with the old title: the response is **stale**. The cache keeps serving it until the TTL
ends, because nothing told it that book 1 changed. This is what happens whenever data changes
through another path: a back-office tool, a batch job, another service.

### 6. Mutation through the cache: invalidation

Send the same mutation **through the cache**:

```bash
curl -i $PROXY -H 'content-type: application/json' --data "$UPDATE"
```

```text
HTTP/1.1 200 OK
x-cache: BYPASS
x-cache-invalidated: 2
x-cache-reason: mutation

{"data":{"updateBook":{"id":"1","title":"Updated Book Title"}}}
```

The mutation is never cached. Its response contains `Book` 1, so the cache removed both entries
that contain book 1: the `books` list and the `book(id: "1")` lookup. The `book(id: "2")` entry
is kept. The next read is a `MISS` with the new title:

```text
HTTP/1.1 200 OK
x-cache: MISS
{"data":{"books":[{"id":"1","title":"Updated Book Title", ...
```

### 7. The same read with HTTP QUERY

```bash
curl -i -X QUERY $PROXY -H 'content-type: application/json' --data "$BOOKS"
```

```text
HTTP/1.1 200 OK
x-cache: HIT
x-cache-key: 675f6a613dfae44c
```

A `HIT` on the entry the `POST` in step 6 stored: same operation, same key. See
[GET, POST and QUERY](#get-post-and-query).

### 8. A mutation over QUERY is rejected

```bash
curl -i -X QUERY $PROXY -H 'content-type: application/json' --data "$UPDATE"
```

```text
HTTP/1.1 405 Method Not Allowed
allow: POST
x-cache: BYPASS
x-cache-reason: unsafe-operation-over-query

{"errors":[{"message":"mutation operations must use POST, not QUERY.","extensions":{"code":"METHOD_NOT_ALLOWED"}}]}
```

### 9. TTL expiration

Start the server with `CACHE_TTL_SECONDS=5 npm start`, send the `books` query, wait six seconds
and send it again: the second request is a `MISS`, and `/_cache/stats` counts one more
`expirations`.

### 10. Cache statistics

```bash
curl http://127.0.0.1:4000/_cache/stats
```

After `npm run demo` against `CACHE_TTL_SECONDS=5 npm start`:

```json
{"size":2,"maxEntries":100,"hits":5,"misses":5,"evictions":0,"expirations":1,"invalidations":2}
```

The proxy also logs one line per request in the terminal running `npm start`:

```text
[cache] POST MISS key=675f6a613dfae44c stored ttl=30s
[cache] POST HIT key=675f6a613dfae44c age=0s
[cache] POST BYPASS authenticated (authorization header)
[cache] POST BYPASS mutation, invalidated 2 entries
[cache] QUERY HIT key=675f6a613dfae44c age=0s
[cache] QUERY rejected: mutation over QUERY
```

The same requests are in [`examples/requests.http`](examples/requests.http) for the VS Code REST
Client or the JetBrains HTTP Client.

## How the cache decides

### Diagnostic headers

| Header | Meaning |
| --- | --- |
| `x-cache` | `HIT` (served from cache), `MISS` (fetched from the origin, looked up first), `BYPASS` (not eligible, sent straight to the origin) |
| `x-cache-reason` | Why a request bypassed the cache, or why a `MISS` was not stored (`not-stored:<reason>`) |
| `x-cache-key` | First 16 hex characters of the SHA-256 cache key |
| `x-cache-ttl` | Seconds the entry stays fresh |
| `age` | Seconds since the entry was stored (`HIT` only) |
| `x-cache-invalidated` | Number of entries a mutation removed |

### When a request is cached

A request is looked up and stored only if all of these hold. The `x-cache-reason` for each
refusal is in the right column.

| Check | Bypass reason |
| --- | --- |
| Path is `/graphql` and method is `POST` or `QUERY` (GET is passed through) | `method-not-cached` |
| `Content-Type` is `application/json` | `unsupported-content-type` |
| Body is valid JSON, one operation (no batching), with a `query` string | `invalid-json`, `invalid-body`, `batched-request`, `missing-query` |
| The query parses | `parse-error` |
| The operation to run can be determined (`operationName` for multi-operation documents) | `operation-not-found` |
| The document validates against the schema (no unknown fields) | `invalid-document` |
| Variables match their declared types | `invalid-variables` |
| The operation is a query, not a mutation or subscription | `mutation`, `subscription` |
| No introspection (`__schema`, `__type`); `__typename` is fine | `introspection` |
| Every selected field is in the public allowlist (`src/cache/policy.js`) | `non-public-field:<Type.field>` |
| No `Authorization` or `Cookie` request header | `authenticated` |

The operation type, introspection and fields are read from the **parsed GraphQL AST**, never by
searching the query string. A query named `mutationFree`, or one with `# mutation` in a comment,
is still recognized as a query; a mutation preceded by comments or another operation is still
recognized as a mutation. Both cases are in the tests.

The allowlist is **default-deny**. A field added to the schema later is not cached until someone
decides it is public. Forgetting to allow a public field costs a cache miss; forgetting to exclude
a private one would leak data.

### When a response is stored

After a `MISS`, the origin's response is stored only if:

| Check | Reason when not stored |
| --- | --- |
| HTTP status is 200 | `not-stored:status-<code>` |
| The response is JSON | `not-stored:not-json` |
| No `Set-Cookie` header | `not-stored:set-cookie` |
| No `Cache-Control: private` or `no-store` from the origin | `not-stored:origin-cache-control` |
| No `errors` in the GraphQL response | `not-stored:graphql-errors` |
| `data` is present | `not-stored:no-data` |

A GraphQL error can be temporary (a resolver timing out) or specific to one request. Caching it
would serve the failure to everyone until it expires.

### The cache key

`src/cache/key.js` hashes, with SHA-256 over JSON with sorted keys:

- the **host and path**: one cache in front of several hostnames or tenants must never let them
  share entries
- the **normalized operation**: only the selected operation and the fragments it uses, re-printed
  by `graphql`'s `print()`, so whitespace, comments and other operations in the document do not
  matter
- the **coerced variables**: defaults applied, values normalized by their GraphQL types

The HTTP method is not part of the key, so `POST` and `QUERY` share entries.

If an origin reads more request context, such as a tenant header, a locale or a feature flag, that
context must be added to the key, or requests that carry it must bypass the cache. Otherwise one
client is served another client's answer.

### TTL and bounded storage

- Every entry expires after `CACHE_TTL_SECONDS` (default 30). A field can lower that with
  `maxAge` in `src/cache/policy.js`; the effective TTL is the smallest `maxAge` of all selected
  fields, capped by the configured TTL. No field in this example sets one; the tests show how it
  works.
- The store holds at most `CACHE_MAX_ENTRIES` (default 100). When it is full, expired entries are
  dropped first, then the least recently used entry is evicted. Without a bound, every distinct
  variables object would add an entry until the process runs out of memory.

## Mutation-based invalidation

The example implements **entity-based invalidation**, not only TTL expiry.

1. **Tagging.** When a query response is stored, `src/cache/entities.js` walks the response
   together with the operation and the schema, and records every `Book` it contains. The entry is
   tagged `Book` and `Book:<id>`, or `Book:?` if the query did not select `id`.
2. **Purging.** When a mutation's response passes through the cache, the same walk finds the books
   it returned. For `updateBook(id: "1") { id title }`, every entry tagged `Book:1` or `Book:?` is
   removed.
3. **When in doubt, purge more.** If the mutation did not select `id`, every entry containing any
   `Book` is removed. If a mutation ran but returned no identifiable object, the whole cache is
   cleared. A mutation that failed before returning data (`"data": null`) removes nothing.

What this approach does **not** cover, by design of a small example:

- **Writes that bypass the cache.** A change made directly at the origin (step 5 of the
  walkthrough), by another service or a batch job, is not seen. Those entries stay stale until the
  TTL ends. The TTL is the upper bound for staleness.
- **New objects in existing lists.** A mutation that creates a book would return a book no cached
  list contains yet, so cached lists would not be purged. This API has no create mutation; a real
  one needs list-level tags.
- **Side effects.** Only the objects a mutation returns are purged. If a mutation also changes
  other objects, the cache cannot know.
- **Several instances.** Invalidation only reaches the memory of this one process.

## GET, POST and QUERY

| | `GET` | `POST` | `QUERY` ([RFC 10008](https://www.rfc-editor.org/rfc/rfc10008)) |
| --- | --- | --- | --- |
| Where the operation travels | URL query string | Request body | Request body |
| Safe and idempotent | Yes | No | Yes |
| Cached by standard HTTP caches and CDNs | Yes, keyed by URL | Generally not | Allowed, the cache key must include the body |
| Size limits | URL length limits apply | Body | Body |
| Can carry a mutation | Must not (GraphQL over HTTP rejects it) | Yes | Must not |
| Support today | Universal | Universal | New; servers, proxies, firewalls and clients are still adding it |

`POST` is what most GraphQL clients send, which is why standard HTTP caches do not help: they
cannot tell a `POST` that reads from one that writes. The cache in this example parses the body
to find out. `QUERY` states in the method itself that the request only reads, while keeping the
operation in the body.

### QUERY in this example (experimental)

- **GraphQL Yoga does not accept `QUERY`.** Sent directly to the origin, it answers
  `405 Method Not Allowed` with `Allow: GET, POST`. A test checks this.
- **Node.js does.** Its HTTP parser knows the `QUERY` method, so the proxy receives it.
- **The proxy translates.** A `QUERY` request for a query operation is forwarded to the origin as
  `POST` and cached exactly like the same operation over `POST`, sharing the entry.
- **Unsafe operations are rejected.** A mutation or subscription sent with `QUERY` is answered with
  `405`, `Allow: POST`, before it reaches the origin.

This translation is an integration choice of this example, not standard behavior of GraphQL Yoga
or of GraphQL over HTTP. `QUERY` is not a CORS-safelisted method, so browsers send a preflight for
cross-origin `QUERY` requests.

## Configuration

All settings are environment variables with defaults. No `.env` file is needed.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4000` | Port of the cache proxy |
| `ORIGIN_PORT` | `4001` | Port of the GraphQL origin |
| `HOST` | `127.0.0.1` | Interface both servers bind to |
| `CACHE_TTL_SECONDS` | `30` | Default and maximum TTL of an entry |
| `CACHE_MAX_ENTRIES` | `100` | Maximum number of cached responses |
| `ORIGIN_DELAY_MS` | `0` | Artificial origin latency. Set `400` to make a HIT visibly faster than a MISS |

Example: `CACHE_TTL_SECONDS=5 ORIGIN_DELAY_MS=400 npm start`.

## Tests

```bash
npm test
```

The suite uses the Node.js built-in test runner and a fake clock, so TTL tests do not sleep.

| File | Covers |
| --- | --- |
| `test/caching.test.js` | MISS then HIT, query normalization, variables, `operationName`, host isolation, TTL and `maxAge`, LRU bound |
| `test/mutations.test.js` | Mutations never cached, AST-based detection, entity invalidation, stale data without invalidation, conservative purges |
| `test/safety.test.js` | `Authorization` and `Cookie` bypass, no cross-user sharing, introspection, allowlist, invalid documents, error responses not stored |
| `test/query-method.test.js` | Yoga rejects `QUERY`, the proxy serves and caches it, shares entries with `POST`, rejects mutations |
| `test/server.test.js` | End to end over real HTTP on random ports |

## Troubleshooting

**`Error: listen EADDRINUSE` on start.** Port 4000 or 4001 is taken, often by a previous
`npm start`. Stop it, or pick other ports: `PORT=5000 ORIGIN_PORT=5001 npm start` (and
`PROXY=http://127.0.0.1:5000/graphql ORIGIN=http://127.0.0.1:5001/graphql npm run demo`).

**`npm install` warns about the engine, or Yoga fails to start.** Check `node --version`; Node.js
22.15 or newer is required.

**Always `BYPASS`.** Read `x-cache-reason`. Common causes: a missing
`content-type: application/json` header (`unsupported-content-type`), an `Authorization` or
`Cookie` header your HTTP client adds automatically (`authenticated`), or a field that is not in
the allowlist (`non-public-field:Type.field`).

**Always `MISS`, never `HIT`.** Read `x-cache-reason` on the `MISS`. `not-stored:graphql-errors`
means the response had errors. If there is no reason, compare `x-cache-key` between requests:
different variables, a different host (`localhost` versus `127.0.0.1`) or a different operation
give different keys. A TTL shorter than the time between requests also causes it.

**The demo shows unexpected titles.** The data is in memory and the demo changes book 1. Restart
the server before running `npm run demo` again.

**`curl -X QUERY` returns 405.** Check that the request goes to the proxy (port 4000), not to the
origin (port 4001), and that the operation is a query. Mutations are rejected over `QUERY` on
purpose.

## Limitations

This example teaches the moving parts. It deliberately leaves out what a production cache needs:

- **One process.** Entries live in memory, are lost on restart, and are not shared between
  instances or regions. Invalidation reaches only this process.
- **No request collapsing.** When a popular entry expires, every concurrent request goes to the
  origin.
- **No stale-while-revalidate.** An expired entry is never served while a fresh one is fetched.
- **Blunt authentication handling.** Every request with `Authorization` or `Cookie` bypasses the
  cache. Caching per user or per organization needs partitioned keys.
- **No persisted queries, no batching, no subscriptions.**
- **Invalidation only sees mutations that pass through it**, see
  [Mutation-based invalidation](#mutation-based-invalidation).
- **No metrics, limits or protection** beyond a 1 MiB request body limit.

## Where a managed GraphQL edge cache fits

```text
  client ──► GraphQL edge cache (close to the client) ──► your GraphQL origin
```

A dedicated GraphQL edge cache moves the logic of this example out of your application and in
front of it, at locations close to your clients. [GraphPilot](https://graphpilot.io/) provides
managed GraphQL edge caching. According to its documentation, it covers parts this example leaves
out:

- **Automatic keys from schema and response data.** GraphPilot derives surrogate keys from your
  schema and each response (one per returned object), and a mutation purges what it returned
  automatically. Clients do not have to select `id`; selection set expansion adds the fields a key
  needs. See [cache invalidation](https://docs.graphpilot.io/invalidation/).
- **Purges from outside**, for writes that bypass the cache, through an API, a CLI and the portal.
- **Request collapsing**, so an expiring entry does not send every waiting client to your origin.
  See [request collapsing](https://docs.graphpilot.io/caching/request-collapsing/).
- **Stale windows and partitioning** (who may share an entry: everyone, an organization, or one
  caller) instead of bypassing every authenticated request.
- **HTTP `QUERY`.** GraphPilot accepts `QUERY` from clients and caches it like the same operation
  over `POST`; `origin.method_rewrite` can downgrade it to `POST` for an origin that does not
  support it, as this example does. See the
  [configuration reference](https://docs.graphpilot.io/reference/configuration/).

The example in this folder stays fully functional without GraphPilot. To put an edge cache in
front of the same Book API, point it at the origin (or at a public tunnel to it) instead of at
the local proxy.
