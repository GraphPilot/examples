// End-to-end over real HTTP: starts the origin and the proxy on random ports.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startServers } from '../src/server.js';
import { BOOKS_QUERY } from './helpers.js';

let servers;
before(async () => {
  servers = await startServers(
    { host: '127.0.0.1', port: 0, originPort: 0, ttlSeconds: 30, maxEntries: 100, originDelayMs: 0 },
    { log: () => {} },
  );
});
after(() => servers.close());

const post = (body, { method = 'POST', headers = {} } = {}) =>
  fetch(`${servers.proxyUrl}/graphql`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

test('MISS, HIT, BYPASS and invalidation over real HTTP', async () => {
  const miss = await post({ query: BOOKS_QUERY });
  assert.equal(miss.headers.get('x-cache'), 'MISS');
  const hit = await post({ query: BOOKS_QUERY });
  assert.equal(hit.headers.get('x-cache'), 'HIT');
  assert.deepEqual(await hit.json(), await miss.json());

  const authed = await post({ query: BOOKS_QUERY }, { headers: { authorization: 'Bearer demo-token-alice' } });
  assert.equal(authed.headers.get('x-cache'), 'BYPASS');

  const mutation = await post({ query: 'mutation { updateBook(id: "1", title: "Updated Book Title") { id title } }' });
  assert.equal(mutation.headers.get('x-cache-invalidated'), '1');

  const after = await post({ query: BOOKS_QUERY });
  assert.equal(after.headers.get('x-cache'), 'MISS');
  assert.equal((await after.json()).data.books[0].title, 'Updated Book Title');
});

test('the QUERY method works over real HTTP', async () => {
  const response = await post({ query: '{ book(id: "2") { id title } }' }, { method: 'QUERY' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-cache'), 'MISS');
  assert.equal((await response.json()).data.book.id, '2');
});

test('the stats endpoint reports the cache state', async () => {
  const stats = await (await fetch(`${servers.proxyUrl}/_cache/stats`)).json();
  assert.equal(stats.maxEntries, 100);
  assert.ok(stats.hits >= 1);
});
