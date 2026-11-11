<p align="center">
  <a href="https://graphpilot.io/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="../.github/assets/logo_plane_name_dark.png">
      <img src="../.github/assets/logo_plane_name_light.png" alt="GraphPilot" width="280">
    </picture>
  </a>
</p>

# GraphQL POST caching: the Book demo

A small Book GraphQL API that you can call **directly** and **through the GraphPilot edge cache**,
with the same queries, the same mutation and the same data. It accompanies the GraphPilot blog
article **"How to Cache GraphQL POST Requests: A Practical Guide"** and the GraphPilot demo
videos.

| Part | Folder | Needs a GraphPilot account |
| --- | --- | --- |
| **Book origin**: a plain GraphQL Yoga server, no cache in it | [`origin/`](origin/) | No |
| **GraphPilot demo**: the same origin behind the real GraphPilot edge cache, plus a script that compares both endpoints | [`graphpilot/`](graphpilot/) | Yes |
| **Educational cache**: a hand-written in-memory cache for learning how GraphQL caching works. Not GraphPilot, and not used by the GraphPilot demo | [`educational-cache/`](educational-cache/) | No |

## Contents

- [Architecture](#architecture)
- [Quick start: the origin on its own](#quick-start-the-origin-on-its-own)
- [The Book API](#the-book-api)
- [Put GraphPilot in front of the origin](#put-graphpilot-in-front-of-the-origin)
- [Compare the two endpoints](#compare-the-two-endpoints)
- [What the demo does not cover](#what-the-demo-does-not-cover)
- [Troubleshooting](#troubleshooting)
- [Tests](#tests)
- [The educational cache](#the-educational-cache)

## Architecture

```text
  1. direct, no cache
  client ── POST /graphql ─────────────────────────────┐
                                                       ▼
                                          ┌──────────────────────────┐
  2. through GraphPilot                   │  Book origin (origin/)   │
  client ── POST /graphql ─► GraphPilot ─►│  GraphQL Yoga, no cache  │
         ◄─ gp-cache: MISS / HIT / PASS   └──────────────────────────┘
```

One origin, two endpoints:

1. **Direct**: `http://127.0.0.1:4000/graphql` (or wherever you run the origin). Every request
   runs the resolvers.
2. **Through GraphPilot**: `https://<subdomain>.<label>.graphpilot.cloud/graphql`. GraphPilot
   answers repeated queries from its edge cache and purges cached responses after a mutation.

The origin contains no caching code. Everything GraphPilot needs is declarative: cache hints in
[`origin/schema.graphql`](origin/schema.graphql) and one setting in
[`graphpilot/gpilot.toml`](graphpilot/gpilot.toml).

## Quick start: the origin on its own

Requirements: Node.js 22.15 or newer (GraphQL Yoga 6 requires it) and npm. The comparison script
also needs `curl` and `bash`.

```bash
cd graphql-post-caching
npm install
npm run origin
```

```text
Book GraphQL origin: http://127.0.0.1:4000/graphql  (no cache in front)
Origin delay 0 ms. Data is in memory; restart to reset it. Ctrl+C to stop.
```

In a second terminal:

```bash
curl http://127.0.0.1:4000/graphql \
  -H 'content-type: application/json' \
  --data '{"query":"{ books { id title author } }"}'
```

```json
{"data":{"books":[{"id":"1","title":"The Pragmatic Programmer","author":"Hunt & Thomas"},{"id":"2","title":"Designing Data-Intensive Applications","author":"Martin Kleppmann"},{"id":"3","title":"Clean Architecture","author":"Robert C. Martin"},{"id":"4","title":"Dune","author":"Frank Herbert"}]}}
```

The origin logs one line for every request that reaches it:

```text
13:50:07 POST /graphql reached the origin
```

A response GraphPilot serves from its cache never reaches the origin, so it never appears in this
log. That is the simplest way to see a cache `HIT` on camera.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4000` | Port of the origin |
| `HOST` | `127.0.0.1` | Interface to bind to. Use `0.0.0.0` when the origin runs on a server or in a container |
| `ORIGIN_DELAY_MS` | `0` | Artificial latency per request. `400` makes the difference between the origin and a cache `HIT` easy to see |

## The Book API

```graphql
type Book @cacheControl(maxAge: 30, scope: PUBLIC) {
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

The full file, including the `@cacheControl` declaration, is
[`origin/schema.graphql`](origin/schema.graphql). The seed data is the bookshop from the
GraphPilot demo videos:

| id | title | author | category |
| --- | --- | --- | --- |
| 1 | The Pragmatic Programmer | Hunt & Thomas | software |
| 2 | Designing Data-Intensive Applications | Martin Kleppmann | software |
| 3 | Clean Architecture | Robert C. Martin | software |
| 4 | Dune | Frank Herbert | scifi |

The demo uses these operations:

```graphql
# The query
{ books { id title author } }

# The mutation
mutation {
  updateBook(id: "1", title: "Updated Book Title") {
    id
    title
  }
}
```

The data lives in memory. Restart the origin to reset it.

### Why the schema has `@cacheControl`

GraphQL Yoga sends no `Cache-Control` header, so GraphPilot takes the cache policy from
`@cacheControl` hints in the deployed schema, in the format of Apollo's cache control plugin.
`Book` is cached for 30 seconds and is `PUBLIC`: every client gets the same answer, so they may
share one cache entry. `books` and `book` carry no hint of their own and take `Book`'s. Yoga
itself ignores the directive; it is declared in the schema only so the schema stays valid. See
[GraphQL Yoga](https://docs.graphpilot.io/connect/graphql-yoga/) and
[lifetime from the schema](https://docs.graphpilot.io/caching/lifetime/schema/) in the
GraphPilot documentation.

## Put GraphPilot in front of the origin

This uses only documented GraphPilot features and the `gpilot` CLI. The full walkthrough is the
[GraphQL quickstart](https://docs.graphpilot.io/getting-started/quickstart/).

### 1. Make the origin reachable

GraphPilot connects to your origin over the internet; `127.0.0.1` on your laptop is not
reachable. Either run `npm run origin` on a server (with `HOST=0.0.0.0`) behind HTTPS, or expose
your local origin through a tunnel such as Cloudflare Tunnel or ngrok. Note the resulting base
URL, for example `https://books-origin.example.com`.

The comparison needs the direct endpoint to be the **same running origin** GraphPilot forwards
to, so both see the same data.

### 2. Install the CLI and log in

Create an account at [cockpit.graphpilot.io](https://cockpit.graphpilot.io/signup), then:

```bash
brew install graphpilot/tap/gpilot     # other platforms: https://docs.graphpilot.io/cli/installation/
gpilot auth login
```

### 3. Create the service

```bash
gpilot service create --name "Book Demo" --subdomain book-demo \
  --url https://books-origin.example.com --no-deploy
gpilot service select book-demo
```

`--url` is the origin's base URL without `/graphql`: GraphPilot forwards the path the client
sent. The command prints the service's signing key **once**; store it in your secret manager if
you want to verify request signatures later (see
[what the demo does not cover](#what-the-demo-does-not-cover)).

### 4. Deploy the schema and the config

From the `graphql-post-caching/` folder:

```bash
gpilot deploy --schema origin/schema.graphql --config graphpilot/gpilot.toml
```

[`graphpilot/gpilot.toml`](graphpilot/gpilot.toml) changes one default:

```toml
[response]
surrogate_key_header = true
```

It adds the `gp-surrogate-key` response header, so you can see which keys a response is tagged
with, such as `Book:id:1`. Everything else is GraphPilot's default: GraphQL on `/graphql`, cache
lifetimes from the schema, an entity key for every object with an `id` field, and the `gp-cache`
headers.

When the deployment is live, the service answers at
`https://book-demo.<label>.graphpilot.cloud/graphql`, where `<label>` is your organization's
hostname label, which the portal shows. Going live usually takes a few minutes; for an
organization's first service it can take up to an hour while its certificate is issued.

## Compare the two endpoints

```bash
export ORIGIN_URL=https://books-origin.example.com/graphql
export GRAPHPILOT_URL=https://book-demo.<label>.graphpilot.cloud/graphql
npm run compare
```

[`graphpilot/compare.sh`](graphpilot/compare.sh) sends the same requests to both endpoints and
prints the HTTP status, `gp-cache`, the timing, the entry's age and remaining freshness, the
`Book:id:*` surrogate keys and the data. Without `GRAPHPILOT_URL` it runs only the direct
requests. What to expect:

| Step | Requests | Expected |
| --- | --- | --- |
| 0 | `updateBook` back to the original title, through GraphPilot | Resets book 1 and purges its cached copies, so the run starts clean |
| 1 | `books` twice, **direct** | No `gp-cache` header. Both requests reach the origin |
| 2 | `books` twice, **through GraphPilot** | `MISS`, then `HIT`. The `HIT` does not reach the origin |
| 3 | `book(id: $id)` with `id` 1, 2, then 1 again | `MISS`, `MISS`, `HIT`: different variables are different entries |
| 4 | `updateBook(id: "1", title: "Updated Book Title")`, then `books` | Mutation: `PASS` with `CACHE_SKIPPED_UNCACHEABLE_OPERATION`. Then `MISS` with the new title, and `HIT` again |
| 5 | Change book 1 **directly at the origin**, then `books` through GraphPilot | `HIT` with the **old** title: GraphPilot never saw this write |
| 6 | Restore book 1 through GraphPilot, then `books` | `MISS` with the original title |

Step 4 is automatic invalidation. The cached `books` and `book(id: "1")` responses were tagged
`Book:id:1`, because they contained book 1. The mutation's response contained book 1 as well, so
GraphPilot purged every response tagged `Book:id:1`. Nothing in the origin or the config asks for
this. See [automatic invalidation](https://docs.graphpilot.io/invalidation/automatic/).

Step 5 is the limit of automatic invalidation: a change that does not go through GraphPilot
(an admin tool, an import job, or here a request straight to the origin) purges nothing. The
stale entry stays until its 30 seconds are over, or until you purge the key yourself:

```bash
gpilot service purge Book:id:1
```

See [purging through the API and CLI](https://docs.graphpilot.io/invalidation/api/).

Purges reach GraphPilot's edge locations asynchronously, usually within seconds. The script waits
`PURGE_WAIT_SECONDS` (default `3`) after each mutation before it reads again.

### The same requests with curl

Replace `$URL` with either endpoint:

```bash
# The query. Through GraphPilot: MISS the first time, HIT the second time.
curl -sS -D - -o /dev/null "$URL" \
  -H 'content-type: application/json' \
  --data '{"query":"{ books { id title author } }"}' | grep -i '^gp-'

# The mutation. Through GraphPilot: PASS, and the cached books are purged.
curl -sS "$URL" \
  -H 'content-type: application/json' \
  --data '{"query":"mutation { updateBook(id: \"1\", title: \"Updated Book Title\") { id title } }"}'
```

Through GraphPilot, a `HIT` looks like this (the values depend on timing):

```text
gp-cache: HIT
gp-cache-hits: 1
gp-cache-age: 4
gp-cache-max-age: 30
gp-cache-remaining: 26
gp-surrogate-key: ...
```

Direct, there is no `gp-` header at all. What each header means:
[cache statuses](https://docs.graphpilot.io/caching/statuses/) and the
[headers reference](https://docs.graphpilot.io/reference/headers/).

## What the demo does not cover

- **Request signing.** GraphPilot signs every request it forwards, and in production the origin
  should refuse requests that are not signed, so it only trusts traffic that came through
  GraphPilot. This demo leaves the origin open on purpose, because the comparison needs the
  direct endpoint. See [request signing](https://docs.graphpilot.io/security/request-signing/).
- **Per-user data.** Every field here is `PUBLIC`. Data that differs per user or per
  organization needs a `PRIVATE` or named scope; see
  [who shares an entry](https://docs.graphpilot.io/caching/partitioning/).
- **New books in cached lists.** The API has no create mutation. A mutation purges the objects
  it returns, so a new object is not in any cached list yet; see
  [automatic invalidation](https://docs.graphpilot.io/invalidation/automatic/) for how lists
  are handled.
- **HTTP `QUERY`** ([RFC 10008](https://www.rfc-editor.org/rfc/rfc10008)). The GraphPilot
  configuration reference documents `QUERY` support and an `origin.method_rewrite` setting. This
  demo does not use or verify it, and GraphQL Yoga answers `QUERY` with `405`, so the direct
  endpoint could not take part in that comparison. The educational cache shows the method; see
  [GET, POST and QUERY](educational-cache/README.md#get-post-and-query).

## Troubleshooting

**`gp-cache: PASS` on the query.** Read `gp-cache-reason`. This origin sets no cookies and sends
no `Cache-Control`, so the usual first-deployment causes do not apply. Check that you deployed
`origin/schema.graphql` (with its `@cacheControl` hints) and not a schema pulled by
introspection, which carries no hints. See
[why is nothing cached?](https://docs.graphpilot.io/troubleshooting/why-is-nothing-cached/).

**The first request of a run is already a `HIT`.** An earlier run cached it within the last 30
seconds. Step 0 of the script purges book 1's entries; for anything else, wait 30 seconds or run
`gpilot service purge --all`.

**Still a `HIT` with the old title right after a mutation.** Purges are asynchronous. Retry after
a moment, or raise `PURGE_WAIT_SECONDS`.

**Step 5 shows the new title through GraphPilot.** `ORIGIN_URL` is not the origin GraphPilot
forwards to, or the step ran after the entry expired. Point both at the same running origin.

**HTTP `500` with `unknown domain` right after the first deployment.** The hostname is not yet
served by every edge location. Retry after a few minutes.

**`Error: listen EADDRINUSE` from `npm run origin`.** Port 4000 is taken. Use another one:
`PORT=4200 npm run origin`, and set `ORIGIN_URL` to match.

## Tests

```bash
npm test
```

| File | Covers |
| --- | --- |
| `test/origin.test.js` | The origin on its own: the Book queries and mutation, every request reaching it, no `Set-Cookie` or `Cache-Control`, and the `@cacheControl` hint and `id` field in `origin/schema.graphql` |
| `test/educational-cache/*.test.js` | The educational cache, see its README |

The tests run without network access and without a GraphPilot account. They do not test
GraphPilot itself; `npm run compare` against a deployed service does.

## The educational cache

[`educational-cache/`](educational-cache/README.md) is a separate, hand-written in-memory cache
in front of its own copy of the same origin (ports 4100 and 4101). It shows how cache keys,
TTLs, bypass rules and invalidation work, and how HTTP `QUERY` differs from `POST`. It is for
learning, it is not GraphPilot, and the GraphPilot demo does not use it.

```bash
npm run educational        # start it
npm run educational:demo   # walk through every scenario
```

## Repository layout

| Path | What it is |
| --- | --- |
| `origin/schema.graphql` | The Book schema, served by Yoga and deployed to GraphPilot |
| `origin/schema.js`, `origin/data.js` | Resolvers and in-memory seed data |
| `origin/create-origin.js`, `origin/server.js` | The GraphQL Yoga origin and its entry point (`npm run origin`) |
| `graphpilot/gpilot.toml` | GraphPilot service configuration |
| `graphpilot/compare.sh` | Direct versus GraphPilot comparison (`npm run compare`) |
| `educational-cache/` | The educational in-memory cache, its examples and README |
| `test/` | Automated tests (`npm test`) |
