import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BOOKS_QUERY, createTestEnv } from './helpers.js';

const BOOK_BY_ID = 'query Book($id: ID!) { book(id: $id) { id title author } }';
const BOOKS_BY_CATEGORY = 'query Books($category: String) { books(category: $category) { id title } }';

describe('POST caching', () => {
  test('first request is a MISS, the identical second request is a HIT', async () => {
    const env = createTestEnv();
    const first = await env.send({ query: BOOKS_QUERY });
    const second = await env.send({ query: BOOKS_QUERY });

    assert.equal(first.cache, 'MISS');
    assert.equal(second.cache, 'HIT');
    assert.deepEqual(second.body, first.body);
    assert.equal(second.headers.get('x-cache-key'), first.headers.get('x-cache-key'));
    assert.equal(first.body.data.books[0].title, 'The Pragmatic Programmer');
    assert.equal(env.originRequests, 1, 'the HIT must not reach the origin');
  });

  test('whitespace and comments do not change the cache key', async () => {
    const env = createTestEnv();
    await env.send({ query: BOOKS_QUERY });
    const reformatted = await env.send({ query: '# all books\n{\n  books {\n    id\n    title\n    author\n  }\n}' });
    assert.equal(reformatted.cache, 'HIT');
  });

  test('different variables get separate cache entries', async () => {
    const env = createTestEnv();
    const one = await env.send({ query: BOOK_BY_ID, variables: { id: '1' } });
    const two = await env.send({ query: BOOK_BY_ID, variables: { id: '2' } });
    const oneAgain = await env.send({ query: BOOK_BY_ID, variables: { id: '1' } });

    assert.equal(one.cache, 'MISS');
    assert.equal(two.cache, 'MISS');
    assert.notEqual(one.headers.get('x-cache-key'), two.headers.get('x-cache-key'));
    assert.equal(two.body.data.book.title, 'Designing Data-Intensive Applications');
    assert.equal(oneAgain.cache, 'HIT');
    assert.equal(oneAgain.body.data.book.id, '1');
  });

  test('variables are coerced and key order does not matter', async () => {
    const env = createTestEnv();
    await env.send({ query: BOOK_BY_ID, variables: { id: '1' } });
    // ID accepts an Int; the server coerces 1 to "1", so the answer is identical.
    assert.equal((await env.send({ query: BOOK_BY_ID, variables: { id: 1 } })).cache, 'HIT');

    const twoVars = 'query Q($id: ID!, $category: String) { book(id: $id) { id } books(category: $category) { id } }';
    await env.send({ query: twoVars, variables: { id: '1', category: 'scifi' } });
    const reordered = await env.send({ query: twoVars, variables: { category: 'scifi', id: '1' } });
    assert.equal(reordered.cache, 'HIT');
  });

  test('an omitted optional variable and a different value are different entries', async () => {
    const env = createTestEnv();
    const all = await env.send({ query: BOOKS_BY_CATEGORY });
    const scifi = await env.send({ query: BOOKS_BY_CATEGORY, variables: { category: 'scifi' } });
    assert.equal(all.cache, 'MISS');
    assert.equal(scifi.cache, 'MISS');
    assert.equal(all.body.data.books.length, 4);
    assert.deepEqual(scifi.body.data.books, [{ id: '4', title: 'Dune' }]);
  });

  test('operationName selects the operation; each operation has its own key', async () => {
    const env = createTestEnv();
    const doc = 'query A { books { id } } query B { book(id: "1") { id title } }';
    const a = await env.send({ query: doc, operationName: 'A' });
    const b = await env.send({ query: doc, operationName: 'B' });
    assert.equal(a.cache, 'MISS');
    assert.equal(b.cache, 'MISS');
    assert.equal(b.body.data.book.title, 'The Pragmatic Programmer');
    assert.equal((await env.send({ query: doc, operationName: 'A' })).cache, 'HIT');
  });

  test('different hosts never share entries', async () => {
    const env = createTestEnv();
    await env.send({ query: BOOKS_QUERY }, { host: 'tenant-a.example' });
    const other = await env.send({ query: BOOKS_QUERY }, { host: 'tenant-b.example' });
    assert.equal(other.cache, 'MISS');
  });
});

describe('TTL expiration', () => {
  test('an entry is served until its TTL ends, then fetched again', async () => {
    const env = createTestEnv({ ttlSeconds: 10 });
    const miss = await env.send({ query: BOOKS_QUERY });
    assert.equal(miss.headers.get('x-cache-ttl'), '10');

    env.advance(9);
    const hit = await env.send({ query: BOOKS_QUERY });
    assert.equal(hit.cache, 'HIT');
    assert.equal(hit.headers.get('age'), '9');
    assert.equal(hit.headers.get('x-cache-ttl'), '1');

    env.advance(1);
    assert.equal((await env.send({ query: BOOKS_QUERY })).cache, 'MISS');
    assert.equal(env.originRequests, 2);
  });

  test('a field maxAge in the policy shortens the TTL', async () => {
    const policy = {
      Query: { books: {} },
      Book: { id: {}, title: {}, author: {}, price: { maxAge: 5 } },
    };
    const env = createTestEnv({ ttlSeconds: 30, policy });
    const withPrice = await env.send({ query: '{ books { id price } }' });
    const withoutPrice = await env.send({ query: '{ books { id title } }' });
    assert.equal(withPrice.headers.get('x-cache-ttl'), '5');
    assert.equal(withoutPrice.headers.get('x-cache-ttl'), '30');
  });
});

describe('bounded storage', () => {
  test('never stores more than maxEntries; evicts the least recently used', async () => {
    const env = createTestEnv({ maxEntries: 2 });
    const q = (id) => ({ query: `{ book(id: "${id}") { id } }` });

    await env.send(q(1));
    await env.send(q(2));
    await env.send(q(1)); // HIT: book 1 becomes the most recently used entry
    await env.send(q(3)); // full: evicts book 2

    const stats = env.proxy.cache.stats();
    assert.equal(stats.size, 2);
    assert.equal(stats.evictions, 1);
    assert.equal((await env.send(q(1))).cache, 'HIT');
    assert.equal((await env.send(q(2))).cache, 'MISS');
  });
});
