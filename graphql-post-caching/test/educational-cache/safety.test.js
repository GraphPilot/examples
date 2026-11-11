import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BOOKS_QUERY, createTestEnv } from './helpers.js';

describe('authenticated requests', () => {
  test('a request with an Authorization header bypasses the cache and is never stored', async () => {
    const env = createTestEnv();
    const alice = await env.send({ query: BOOKS_QUERY }, { headers: { authorization: 'Bearer demo-token-alice' } });
    assert.equal(alice.cache, 'BYPASS');
    assert.equal(alice.reason, 'authenticated');
    assert.equal(env.proxy.cache.size, 0);

    // The anonymous request must not be served Alice's response.
    assert.equal((await env.send({ query: BOOKS_QUERY })).cache, 'MISS');
  });

  test('an authenticated request is never served from an existing public entry', async () => {
    const env = createTestEnv();
    await env.send({ query: BOOKS_QUERY });
    const bob = await env.send({ query: BOOKS_QUERY }, { headers: { authorization: 'Bearer demo-token-bob' } });
    assert.equal(bob.cache, 'BYPASS');
    assert.equal(env.originRequests, 2);
  });

  test('two different users each reach the origin', async () => {
    const env = createTestEnv();
    for (const token of ['demo-token-alice', 'demo-token-bob', 'demo-token-alice']) {
      const r = await env.send({ query: BOOKS_QUERY }, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(r.cache, 'BYPASS');
    }
    assert.equal(env.originRequests, 3);
    assert.equal(env.proxy.cache.size, 0);
  });

  test('a request with a Cookie header bypasses the cache', async () => {
    const env = createTestEnv();
    const r = await env.send({ query: BOOKS_QUERY }, { headers: { cookie: 'session=abc' } });
    assert.equal(r.cache, 'BYPASS');
    assert.equal(r.reason, 'authenticated');
  });
});

describe('only eligible queries are cached', () => {
  test('introspection queries bypass the cache', async () => {
    const env = createTestEnv();
    const schemaQuery = await env.send({ query: '{ __schema { queryType { name } } }' });
    const typeQuery = await env.send({ query: '{ __type(name: "Book") { name } }' });
    assert.equal(schemaQuery.cache, 'BYPASS');
    assert.equal(schemaQuery.reason, 'introspection');
    assert.equal(typeQuery.reason, 'introspection');
  });

  test('__typename alone does not prevent caching', async () => {
    const env = createTestEnv();
    await env.send({ query: '{ books { __typename id } }' });
    assert.equal((await env.send({ query: '{ books { __typename id } }' })).cache, 'HIT');
  });

  test('a field missing from the public allowlist bypasses the cache', async () => {
    const policy = { Query: { books: {} }, Book: { id: {}, title: {} } }; // author not public
    const env = createTestEnv({ policy });
    const r = await env.send({ query: BOOKS_QUERY });
    assert.equal(r.cache, 'BYPASS');
    assert.equal(r.reason, 'non-public-field:Book.author');
  });

  test('unknown fields and syntax errors bypass the cache', async () => {
    const env = createTestEnv();
    assert.equal((await env.send({ query: '{ books { id isbn } }' })).reason, 'invalid-document');
    assert.equal((await env.send({ query: '{ books { id ' })).reason, 'parse-error');
    assert.equal(env.proxy.cache.size, 0);
  });

  test('variables that do not match their declared types bypass the cache', async () => {
    const env = createTestEnv();
    const r = await env.send({ query: 'query ($id: ID!) { book(id: $id) { id } }', variables: { id: null } });
    assert.equal(r.cache, 'BYPASS');
    assert.equal(r.reason, 'invalid-variables');
  });

  test('responses with GraphQL errors are not stored', async () => {
    // Simulate a failing resolver, e.g. a database timeout.
    const errorEnv = createTestEnv();
    const original = errorEnv.store.get;
    errorEnv.store.get = () => {
      throw new Error('database timeout');
    };
    const failed = await errorEnv.send({ query: '{ book(id: "1") { id } }' });
    assert.equal(failed.cache, 'MISS');
    assert.equal(failed.reason, 'not-stored:graphql-errors');
    assert.ok(failed.body.errors);
    errorEnv.store.get = original;
    const recovered = await errorEnv.send({ query: '{ book(id: "1") { id } }' });
    assert.equal(recovered.cache, 'MISS', 'the error must not have been cached');
    assert.equal(recovered.body.data.book.id, '1');
  });

  test('batched requests and non-JSON bodies bypass the cache', async () => {
    const env = createTestEnv();
    assert.equal((await env.send([{ query: BOOKS_QUERY }])).reason, 'batched-request');
    assert.equal((await env.send('{not json')).reason, 'invalid-json');
  });

  test('a query whose text contains the word "mutation" is still cached', async () => {
    // Detection uses the parsed AST. A string search would misclassify this.
    const env = createTestEnv();
    const query = 'query mutationFree { books { id } } # mutation { updateBook }';
    await env.send({ query });
    assert.equal((await env.send({ query })).cache, 'HIT');
  });
});
