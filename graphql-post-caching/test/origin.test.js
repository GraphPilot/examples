// The Book origin on its own, and the properties the GraphPilot setup relies on.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { buildSchema, getDirectiveValues, parse } from 'graphql';
import { startOrigin } from '../origin/server.js';

const BOOKS_QUERY = '{ books { id title author } }';
let origin;
const requests = [];

before(async () => {
  origin = await startOrigin({ port: 0, log: (line) => requests.push(line) });
});
after(() => origin.close());

const post = (body) =>
  fetch(origin.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('Book origin (standalone, no cache)', () => {
  test('answers the books query with the seed data', async () => {
    const response = await post({ query: BOOKS_QUERY });
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.books.length, 4);
    assert.deepEqual(data.books[0], { id: '1', title: 'The Pragmatic Programmer', author: 'Hunt & Thomas' });
  });

  test('every request reaches the origin: there is no cache in it', async () => {
    const before = requests.length;
    await post({ query: BOOKS_QUERY });
    await post({ query: BOOKS_QUERY });
    assert.equal(requests.length - before, 2);
  });

  test('sends no Set-Cookie and no Cache-Control, so the schema hints decide caching', async () => {
    const response = await post({ query: BOOKS_QUERY });
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('cache-control'), null);
  });

  test('variables select a book; an unknown id returns null', async () => {
    const query = 'query Book($id: ID!) { book(id: $id) { id title } }';
    const two = await (await post({ query, variables: { id: '2' } })).json();
    const missing = await (await post({ query, variables: { id: '999' } })).json();
    assert.deepEqual(two.data.book, { id: '2', title: 'Designing Data-Intensive Applications' });
    assert.equal(missing.data.book, null);
  });

  test('updateBook changes the title and returns the changed book', async () => {
    const mutation = 'mutation { updateBook(id: "1", title: "Updated Book Title") { id title } }';
    const result = await (await post({ query: mutation })).json();
    assert.deepEqual(result.data.updateBook, { id: '1', title: 'Updated Book Title' });
    const book = await (await post({ query: '{ book(id: "1") { title } }' })).json();
    assert.equal(book.data.book.title, 'Updated Book Title');
  });

  test('updateBook on an unknown id is an error', async () => {
    const result = await (await post({ query: 'mutation { updateBook(id: "999", title: "X") { id } }' })).json();
    assert.equal(result.errors[0].extensions.code, 'NOT_FOUND');
  });
});

describe('origin/schema.graphql (the schema deployed to GraphPilot)', () => {
  const sdl = readFileSync(new URL('../origin/schema.graphql', import.meta.url), 'utf8');

  test('is valid SDL with the operations the demo uses', () => {
    const schema = buildSchema(sdl);
    assert.ok(schema.getQueryType().getFields().books);
    assert.ok(schema.getQueryType().getFields().book);
    assert.equal(String(schema.getMutationType().getFields().updateBook.type), 'Book!');
  });

  test('Book carries a PUBLIC @cacheControl hint of 30 seconds', () => {
    const schema = buildSchema(sdl);
    const book = schema.getType('Book');
    const hint = getDirectiveValues(schema.getDirective('cacheControl'), book.astNode);
    assert.deepEqual({ ...hint }, { maxAge: 30, scope: 'PUBLIC' });
  });

  test('Book has an id field, the key GraphPilot derives Book:id:<id> from', () => {
    assert.ok(buildSchema(sdl).getType('Book').getFields().id);
    assert.doesNotThrow(() => parse(sdl));
  });
});
