import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BOOKS_QUERY, createTestEnv } from './helpers.js';

const UPDATE_BOOK_1 = 'mutation { updateBook(id: "1", title: "Updated Book Title") { id title } }';
const BOOK = (id) => ({ query: `{ book(id: "${id}") { id title } }` });

describe('mutations', () => {
  test('mutations are never cached and always reach the origin', async () => {
    const env = createTestEnv();
    const first = await env.send({ query: UPDATE_BOOK_1 });
    const second = await env.send({ query: UPDATE_BOOK_1 });
    assert.equal(first.cache, 'BYPASS');
    assert.equal(first.reason, 'mutation');
    assert.equal(second.cache, 'BYPASS');
    assert.equal(env.originRequests, 2);
    assert.deepEqual(first.body.data.updateBook, { id: '1', title: 'Updated Book Title' });
  });

  test('a mutation is detected after comments and in a multi-operation document', async () => {
    const env = createTestEnv();
    const doc = '# read first\nquery Read { books { id } }\nmutation Write { updateBook(id: "2", title: "X") { id } }';
    assert.equal((await env.send({ query: doc, operationName: 'Read' })).cache, 'MISS');
    assert.equal((await env.send({ query: doc, operationName: 'Write' })).reason, 'mutation');
  });

  test('a mutation invalidates every cached response containing the changed book', async () => {
    const env = createTestEnv();
    await env.send({ query: BOOKS_QUERY }); // contains books 1-4
    await env.send(BOOK(1));
    await env.send(BOOK(2));
    assert.equal((await env.send({ query: BOOKS_QUERY })).cache, 'HIT');

    const mutation = await env.send({ query: UPDATE_BOOK_1 });
    assert.equal(mutation.headers.get('x-cache-invalidated'), '2'); // the list and book 1

    const list = await env.send({ query: BOOKS_QUERY });
    assert.equal(list.cache, 'MISS');
    assert.equal(list.body.data.books[0].title, 'Updated Book Title');

    const book1 = await env.send(BOOK(1));
    assert.equal(book1.cache, 'MISS');
    assert.equal(book1.body.data.book.title, 'Updated Book Title');

    assert.equal((await env.send(BOOK(2))).cache, 'HIT', 'unrelated entries survive');
  });

  test('without invalidation the cache serves stale data until the TTL ends', async () => {
    const env = createTestEnv({ ttlSeconds: 30 });
    await env.send({ query: BOOKS_QUERY });

    // Change the data directly at the origin. The cache never sees this write.
    await env.sendToOrigin({ query: UPDATE_BOOK_1 });

    const stale = await env.send({ query: BOOKS_QUERY });
    assert.equal(stale.cache, 'HIT');
    assert.equal(stale.body.data.books[0].title, 'The Pragmatic Programmer', 'stale');

    env.advance(30);
    const fresh = await env.send({ query: BOOKS_QUERY });
    assert.equal(fresh.cache, 'MISS');
    assert.equal(fresh.body.data.books[0].title, 'Updated Book Title');
  });

  test('a mutation that does not select id purges every entry containing a Book', async () => {
    const env = createTestEnv();
    await env.send(BOOK(2));
    const r = await env.send({ query: 'mutation { updateBook(id: "1", title: "Y") { title } }' });
    assert.equal(r.headers.get('x-cache-invalidated'), '1');
    assert.equal((await env.send(BOOK(2))).cache, 'MISS');
  });

  test('a cached query that did not select id is still invalidated', async () => {
    const env = createTestEnv();
    await env.send({ query: '{ books { title } }' }); // tagged "Book:?"
    const r = await env.send({ query: UPDATE_BOOK_1 });
    assert.equal(r.headers.get('x-cache-invalidated'), '1');
    const after = await env.send({ query: '{ books { title } }' });
    assert.equal(after.cache, 'MISS');
    assert.equal(after.body.data.books[0].title, 'Updated Book Title');
  });

  test('a failed mutation with no data invalidates nothing', async () => {
    const env = createTestEnv();
    await env.send(BOOK(1));
    // updateBook returns Book!, so the NOT_FOUND error nulls the whole data.
    const r = await env.send({ query: 'mutation { updateBook(id: "999", title: "Z") { id } }' });
    assert.ok(r.body.errors);
    assert.equal(r.headers.get('x-cache-invalidated'), '0');
    assert.equal((await env.send(BOOK(1))).cache, 'HIT');
  });

  test('authenticated mutations invalidate too', async () => {
    const env = createTestEnv();
    await env.send(BOOK(1));
    const r = await env.send({ query: UPDATE_BOOK_1 }, { headers: { authorization: 'Bearer demo-token-alice' } });
    assert.equal(r.headers.get('x-cache-invalidated'), '1');
  });
});
