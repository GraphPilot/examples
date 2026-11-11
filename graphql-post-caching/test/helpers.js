// Shared test setup: an in-process origin, the caching proxy in front of it,
// a fake clock, and a counter of requests that reached the origin.

import { createCachingProxy } from '../src/cache/handler.js';
import { createOrigin } from '../src/origin.js';
import { schema } from '../src/schema.js';

export const BOOKS_QUERY = '{ books { id title author } }';

export function createTestEnv({ ttlSeconds = 30, maxEntries = 100, policy } = {}) {
  let clock = 1_700_000_000_000;
  const { yoga, store } = createOrigin();
  let originRequests = 0;

  const proxy = createCachingProxy({
    origin: (request) => {
      originRequests++;
      return yoga.fetch(request);
    },
    schema,
    ttlSeconds,
    maxEntries,
    now: () => clock,
    ...(policy ? { policy } : {}),
  });

  /** Sends a GraphQL request through the cache proxy. */
  async function send(payload, { method = 'POST', headers = {}, host = 'localhost:4000' } = {}) {
    const response = await proxy.handle(
      new Request(`http://${host}/graphql`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof payload === 'string' ? payload : JSON.stringify(payload),
      }),
    );
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      cache: response.headers.get('x-cache'),
      reason: response.headers.get('x-cache-reason'),
      body: JSON.parse(text),
    };
  }

  /** Sends a request straight to the origin, bypassing the cache. */
  async function sendToOrigin(payload) {
    const response = await yoga.fetch('http://localhost:4001/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return response.json();
  }

  return {
    proxy,
    store,
    send,
    sendToOrigin,
    advance: (seconds) => {
      clock += seconds * 1000;
    },
    get originRequests() {
      return originRequests;
    },
  };
}
