// The caching proxy: sits in front of the GraphQL origin and decides, per
// request, whether to serve from cache (HIT), fetch and store (MISS), or pass
// straight through (BYPASS).
//
// It speaks the Fetch API (Request in, Response out), so the same code runs
// behind node:http (src/server.js) and in-process in the tests.
//
// Diagnostic response headers:
//   x-cache              HIT | MISS | BYPASS
//   x-cache-reason       why a request bypassed the cache, or why a MISS was not stored
//   x-cache-key          the first 16 hex characters of the cache key
//   x-cache-ttl          seconds the entry stays fresh (HIT and stored MISS)
//   age                  seconds since the entry was stored (HIT)
//   x-cache-invalidated  number of entries a mutation removed

import { analyzeGraphQLRequest } from './analyze.js';
import { collectEntities } from './entities.js';
import { createCacheKey } from './key.js';
import { cachePolicy } from './policy.js';
import { ResponseCache } from './store.js';

// Requests carrying these headers may receive a response that belongs to one
// user. Such a response must never be stored in, or served from, a cache that
// every client shares. Bypassing them all is blunt but safe.
const DEFAULT_PRIVATE_HEADERS = ['authorization', 'cookie'];

const GRAPHQL_PATH = '/graphql';

/**
 * @param {object} options
 * @param {(request: Request) => Promise<Response>} options.origin  Forwards a request to the GraphQL origin.
 * @param {import('graphql').GraphQLSchema} options.schema  The origin's schema.
 * @param {object} [options.policy]  Public-field allowlist, see policy.js.
 * @param {number} [options.ttlSeconds]  Default (and maximum) TTL.
 * @param {number} [options.maxEntries]  Upper bound for the number of cached responses.
 * @param {string[]} [options.privateHeaders]  Request headers that force a BYPASS.
 * @param {() => number} [options.now]  Clock in milliseconds (tests use a fake one).
 * @param {(line: string) => void} [options.log]
 */
export function createCachingProxy({
  origin,
  schema,
  policy = cachePolicy,
  ttlSeconds = 30,
  maxEntries = 100,
  privateHeaders = DEFAULT_PRIVATE_HEADERS,
  now = () => Date.now(),
  log = () => {},
}) {
  const cache = new ResponseCache({ maxEntries, now });

  async function handle(request) {
    const url = new URL(request.url);
    const say = (line) => log(`${request.method} ${line}`);

    if (url.pathname === '/_cache/stats' && request.method === 'GET') {
      return Response.json(cache.stats());
    }
    if (url.pathname !== GRAPHQL_PATH) {
      return Response.json({ error: 'Not found. The GraphQL endpoint is /graphql.' }, { status: 404 });
    }

    // GET (and anything else that is not POST or QUERY) is passed through
    // untouched. This example focuses on requests with a body.
    if (request.method !== 'POST' && request.method !== 'QUERY') {
      return bypass(await origin(request), 'method-not-cached');
    }

    const rawBody = await request.text();
    const isQueryMethod = request.method === 'QUERY';
    // EXPERIMENTAL: GraphQL Yoga answers QUERY with 405, so the proxy always
    // talks POST to the origin. The client may use either method.
    const forward = () => origin(copyRequest(request, rawBody, 'POST'));

    if (!(request.headers.get('content-type') ?? '').includes('application/json')) {
      return bypass(await forward(), 'unsupported-content-type');
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return bypass(await forward(), 'invalid-json');
    }

    const analysis = analyzeGraphQLRequest({ schema, policy, body });

    // QUERY is a safe method (RFC 10008): it must not change server state.
    // Refuse anything that is not a query before it reaches the origin.
    if (isQueryMethod && analysis.operationType !== 'query' && analysis.operationType !== null) {
      say(`rejected: ${analysis.operationType} over QUERY`);
      return graphqlError(405, `${analysis.operationType} operations must use POST, not QUERY.`, {
        allow: 'POST',
        'x-cache': 'BYPASS',
        'x-cache-reason': 'unsafe-operation-over-query',
      });
    }

    if (analysis.kind === 'mutation') return handleMutation(analysis, await forward(), say);

    if (analysis.kind === 'bypass') {
      say(`BYPASS ${analysis.reason}`);
      return bypass(await forward(), analysis.reason);
    }

    const privateHeader = privateHeaders.find((name) => request.headers.has(name));
    if (privateHeader) {
      say(`BYPASS authenticated (${privateHeader} header)`);
      return bypass(await forward(), 'authenticated');
    }

    const key = createCacheKey({
      host: url.host,
      path: url.pathname,
      normalizedQuery: analysis.normalizedQuery,
      variables: analysis.variables,
    });
    const shortKey = key.slice(0, 16);

    const hit = cache.get(key);
    if (hit) {
      say(`HIT key=${shortKey} age=${hit.ageSeconds}s`);
      return new Response(hit.body, {
        status: 200,
        headers: {
          'content-type': hit.contentType,
          'x-cache': 'HIT',
          'x-cache-key': shortKey,
          'x-cache-ttl': String(Math.max(0, hit.ttlSeconds - hit.ageSeconds)),
          age: String(hit.ageSeconds),
        },
      });
    }

    const response = await forward();
    const text = await response.text();
    const headers = responseHeaders(response);
    headers.set('x-cache', 'MISS');
    headers.set('x-cache-key', shortKey);

    const verdict = checkStorable(response, text);
    if (verdict.storable) {
      const ttl = Math.min(ttlSeconds, analysis.maxAge);
      const entities = collectEntities({ schema, ...analysis, data: verdict.json.data });
      cache.set(key, {
        body: text,
        contentType: response.headers.get('content-type'),
        ttlSeconds: ttl,
        tags: entityTags(entities),
      });
      headers.set('x-cache-ttl', String(ttl));
      say(`MISS key=${shortKey} stored ttl=${ttl}s`);
    } else {
      headers.set('x-cache-reason', `not-stored:${verdict.reason}`);
      say(`MISS key=${shortKey} not stored (${verdict.reason})`);
    }
    return new Response(text, { status: response.status, headers });
  }

  // Mutations always go to the origin. Afterwards, every cached response that
  // contains an entity the mutation returned is removed.
  async function handleMutation(analysis, response, say) {
    const text = await response.text();
    const headers = responseHeaders(response);
    headers.set('x-cache', 'BYPASS');
    headers.set('x-cache-reason', 'mutation');

    const json = tryParseJson(text);
    const data = json?.data;
    let invalidated = 0;
    if (data != null) {
      const entities = collectEntities({ schema, ...analysis, data });
      if (entities.length > 0) {
        invalidated = cache.invalidateTags(purgeTags(entities));
      } else {
        // The mutation ran (data is present) but returned no entity the
        // cache can identify, for example a null result next to an error.
        // What changed is unknown, so the whole cache is dropped.
        invalidated = cache.clear();
      }
    }
    headers.set('x-cache-invalidated', String(invalidated));
    say(`BYPASS mutation, invalidated ${invalidated} entr${invalidated === 1 ? 'y' : 'ies'}`);
    return new Response(text, { status: response.status, headers });
  }

  function bypass(response, reason) {
    const headers = responseHeaders(response);
    headers.set('x-cache', 'BYPASS');
    headers.set('x-cache-reason', reason);
    return new Response(response.body, { status: response.status, headers });
  }

  return { handle, cache };
}

// Tags for a cached query response:
//   "Book"    the response contains at least one Book
//   "Book:1"  the response contains the Book with id 1
//   "Book:?"  the response contains a Book whose id was not selected
function entityTags(entities) {
  const tags = new Set();
  for (const { typename, id } of entities) {
    tags.add(typename);
    tags.add(id === null ? `${typename}:?` : `${typename}:${id}`);
  }
  return tags;
}

// Tags a mutation response purges:
//   known id   -> "Book:1" plus "Book:?" (entries that may contain it unidentified)
//   unknown id -> "Book" (every entry that contains any Book)
function purgeTags(entities) {
  const tags = new Set();
  for (const { typename, id } of entities) {
    if (id === null) {
      tags.add(typename);
    } else {
      tags.add(`${typename}:${id}`);
      tags.add(`${typename}:?`);
    }
  }
  return tags;
}

// Decides whether an origin response may be stored in the shared cache.
function checkStorable(response, text) {
  if (response.status !== 200) return { storable: false, reason: `status-${response.status}` };
  if (!(response.headers.get('content-type') ?? '').includes('json')) {
    return { storable: false, reason: 'not-json' };
  }
  if (response.headers.has('set-cookie')) return { storable: false, reason: 'set-cookie' };
  const cacheControl = response.headers.get('cache-control') ?? '';
  if (/\b(private|no-store)\b/i.test(cacheControl)) {
    return { storable: false, reason: 'origin-cache-control' };
  }
  const json = tryParseJson(text);
  if (!json || typeof json !== 'object') return { storable: false, reason: 'invalid-json' };
  // A GraphQL error can be temporary (a timeout in a resolver) or specific to
  // this request. Caching it would serve the failure to everyone.
  if (json.errors !== undefined) return { storable: false, reason: 'graphql-errors' };
  if (json.data == null) return { storable: false, reason: 'no-data' };
  return { storable: true, json };
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function copyRequest(request, body, method) {
  return new Request(request.url, { method, headers: request.headers, body });
}

// Copies origin headers that are safe to relay. The proxy re-sends the body, so
// length and encoding headers from the origin no longer apply.
function responseHeaders(response) {
  const headers = new Headers(response.headers);
  for (const name of ['content-length', 'content-encoding', 'transfer-encoding', 'connection']) {
    headers.delete(name);
  }
  return headers;
}

function graphqlError(status, message, extraHeaders) {
  return Response.json(
    { errors: [{ message, extensions: { code: 'METHOD_NOT_ALLOWED' } }] },
    { status, headers: extraHeaders },
  );
}
