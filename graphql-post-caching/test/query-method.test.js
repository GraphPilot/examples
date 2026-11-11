// HTTP QUERY (RFC 10008) support in the proxy. EXPERIMENTAL integration:
// GraphQL Yoga does not accept QUERY, so the proxy forwards it as POST.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createOrigin } from '../src/origin.js';
import { BOOKS_QUERY, createTestEnv } from './helpers.js';

describe('HTTP QUERY method', () => {
  test('GraphQL Yoga itself rejects QUERY (why the proxy translates it)', async () => {
    const { yoga } = createOrigin();
    const response = await yoga.fetch('http://localhost/graphql', {
      method: 'QUERY',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: BOOKS_QUERY }),
    });
    assert.equal(response.status, 405);
  });

  test('a read-only query over QUERY is answered and cached', async () => {
    const env = createTestEnv();
    const first = await env.send({ query: BOOKS_QUERY }, { method: 'QUERY' });
    const second = await env.send({ query: BOOKS_QUERY }, { method: 'QUERY' });
    assert.equal(first.status, 200);
    assert.equal(first.cache, 'MISS');
    assert.equal(first.body.data.books.length, 4);
    assert.equal(second.cache, 'HIT');
  });

  test('POST and QUERY for the same operation share one cache entry', async () => {
    const env = createTestEnv();
    await env.send({ query: BOOKS_QUERY }, { method: 'POST' });
    const viaQuery = await env.send({ query: BOOKS_QUERY }, { method: 'QUERY' });
    assert.equal(viaQuery.cache, 'HIT');
  });

  test('a mutation over QUERY is rejected with 405 and never reaches the origin', async () => {
    const env = createTestEnv();
    const r = await env.send(
      { query: 'mutation { updateBook(id: "1", title: "Updated Book Title") { id title } }' },
      { method: 'QUERY' },
    );
    assert.equal(r.status, 405);
    assert.equal(r.headers.get('allow'), 'POST');
    assert.equal(r.reason, 'unsafe-operation-over-query');
    assert.equal(env.originRequests, 0);
    assert.equal(env.store.get('1').title, 'The Pragmatic Programmer', 'no data changed');
  });

  test('an invalid mutation over QUERY is rejected too', async () => {
    const env = createTestEnv();
    const r = await env.send({ query: 'mutation { updateBook(id: "1") { id } }' }, { method: 'QUERY' });
    assert.equal(r.status, 405);
    assert.equal(env.originRequests, 0);
  });

  test('authenticated QUERY requests bypass the cache', async () => {
    const env = createTestEnv();
    const r = await env.send({ query: BOOKS_QUERY }, { method: 'QUERY', headers: { authorization: 'Bearer x' } });
    assert.equal(r.status, 200);
    assert.equal(r.cache, 'BYPASS');
  });
});
