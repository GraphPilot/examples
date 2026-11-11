// The ready-made requests in requests/ must stay in step with the schema: every .http body and
// every .graphql operation is validated against origin/schema.graphql and executed against the
// origin.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { buildSchema, parse, validate } from 'graphql';
import { createOrigin } from '../origin/create-origin.js';

const sdl = readFileSync(new URL('../origin/schema.graphql', import.meta.url), 'utf8');
const schema = buildSchema(sdl);

/** Splits an .http file into { name, method, url, body } requests. */
function parseHttpFile(text) {
  return text
    .split(/^###/m)
    .slice(1)
    .map((block) => {
      const [nameLine, ...rest] = block.split('\n');
      const lines = rest.filter((line) => !line.startsWith('#'));
      const requestIndex = lines.findIndex((line) => /^[A-Z]+ /.test(line));
      const [method, url] = lines[requestIndex].split(' ');
      const blank = lines.findIndex((line, i) => i > requestIndex && line.trim() === '');
      return { name: nameLine.trim(), method, url, body: JSON.parse(lines.slice(blank + 1).join('\n')) };
    });
}

async function execute(yoga, body) {
  const response = await yoga.fetch('http://localhost/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}

describe('requests/book-demo.http', () => {
  const requests = parseHttpFile(readFileSync(new URL('../requests/book-demo.http', import.meta.url), 'utf8'));

  test('contains the documented requests for both endpoints', () => {
    assert.ok(requests.length >= 8);
    assert.ok(requests.some((r) => r.url === '{{direct}}'));
    assert.ok(requests.some((r) => r.url === '{{graphpilot}}'));
    assert.ok(requests.every((r) => r.method === 'POST'));
  });

  test('every body is valid against the schema and runs without errors, in file order', async () => {
    const { yoga } = createOrigin();
    for (const request of requests) {
      assert.deepEqual(validate(schema, parse(request.body.query)), [], request.name);
      const result = await execute(yoga, request.body);
      assert.equal(result.errors, undefined, `${request.name}: ${JSON.stringify(result.errors)}`);
    }
  });
});

describe('requests/operations/*.graphql', () => {
  const dir = new URL('../requests/operations/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.graphql'));
  const variables = {
    BookById: { id: '1' },
    BooksByCategory: { category: 'scifi' },
    UpdateBook: { id: '2', title: 'Any New Title' },
  };

  test('both documents exist', () => assert.deepEqual(files.sort(), ['mutations.graphql', 'queries.graphql']));

  for (const file of files) {
    test(`${file}: valid against the schema, every operation runs without errors`, async () => {
      const source = readFileSync(new URL(file, dir), 'utf8');
      const document = parse(source);
      assert.deepEqual(validate(schema, document), []);
      const { yoga } = createOrigin();
      for (const operation of document.definitions) {
        const operationName = operation.name.value;
        const result = await execute(yoga, { query: source, operationName, variables: variables[operationName] });
        assert.equal(result.errors, undefined, `${operationName}: ${JSON.stringify(result.errors)}`);
        assert.ok(result.data, operationName);
      }
    });
  }

  test('AllBooks selects the fields of the article query', () => {
    const source = readFileSync(new URL('queries.graphql', dir), 'utf8');
    assert.match(source, /query AllBooks \{\n {2}books \{\n {4}id\n {4}title\n {4}author\n/);
  });
});
