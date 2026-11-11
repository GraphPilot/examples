// Demo safeguards of the public origin: body limit, per-client request limit,
// title length, the / redirect, the health check and the env configuration.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { loadOriginConfig, startOrigin } from '../origin/server.js';

const QUERY = { query: '{ books { id } }' };

async function withOrigin(options, fn) {
  const origin = await startOrigin({ port: 0, log: () => {}, ...options });
  try {
    await fn(origin);
  } finally {
    await origin.close();
  }
}

const post = (url, body, headers = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('request body limit', () => {
  test('a body above MAX_BODY_BYTES is refused with 413 before it reaches GraphQL', async () => {
    await withOrigin({ maxBodyBytes: 100 }, async (origin) => {
      const big = JSON.stringify({ query: `{ books { id } } # ${'x'.repeat(200)}` });
      const response = await post(origin.url, big);
      assert.equal(response.status, 413);
      assert.match((await response.json()).errors[0].message, /larger than 100 bytes/);
      assert.equal((await post(origin.url, QUERY)).status, 200);
    });
  });
});

describe('per-client request limit', () => {
  test('refuses with 429 and Retry-After above the limit, and resets after a minute', async () => {
    let clock = 1_700_000_000_000;
    await withOrigin({ rateLimitPerMinute: 3, now: () => clock }, async (origin) => {
      for (let i = 0; i < 3; i++) assert.equal((await post(origin.url, QUERY)).status, 200);
      const refused = await post(origin.url, QUERY);
      assert.equal(refused.status, 429);
      assert.equal(refused.headers.get('retry-after'), '60');
      clock += 60_000;
      assert.equal((await post(origin.url, QUERY)).status, 200);
    });
  });

  test('with TRUST_PROXY, clients behind one proxy are counted by the proxy-added address', async () => {
    await withOrigin({ rateLimitPerMinute: 1, trustProxy: true }, async (origin) => {
      assert.equal((await post(origin.url, QUERY, { 'x-forwarded-for': '203.0.113.1' })).status, 200);
      assert.equal((await post(origin.url, QUERY, { 'x-forwarded-for': '203.0.113.2' })).status, 200);
      assert.equal((await post(origin.url, QUERY, { 'x-forwarded-for': '203.0.113.1' })).status, 429);
    });
  });

  test('with TRUST_PROXY, a client-supplied X-Forwarded-For entry cannot dodge the limit', async () => {
    await withOrigin({ rateLimitPerMinute: 1, trustProxy: true }, async (origin) => {
      // The proxy appends the address it saw (203.0.113.9) after whatever the client sent.
      assert.equal((await post(origin.url, QUERY, { 'x-forwarded-for': '198.51.100.1, 203.0.113.9' })).status, 200);
      assert.equal((await post(origin.url, QUERY, { 'x-forwarded-for': '198.51.100.2, 203.0.113.9' })).status, 429);
    });
  });

  test('without TRUST_PROXY, X-Forwarded-For cannot be used to dodge the limit', async () => {
    await withOrigin({ rateLimitPerMinute: 1 }, async (origin) => {
      assert.equal((await post(origin.url, QUERY, { 'x-forwarded-for': '203.0.113.1' })).status, 200);
      assert.equal((await post(origin.url, QUERY, { 'x-forwarded-for': '203.0.113.2' })).status, 429);
    });
  });

  test('0 switches the limit off', async () => {
    await withOrigin({ rateLimitPerMinute: 0 }, async (origin) => {
      for (let i = 0; i < 5; i++) assert.equal((await post(origin.url, QUERY)).status, 200);
    });
  });
});

describe('browser and platform endpoints', () => {
  let origin;
  before(async () => {
    origin = await startOrigin({ port: 0, log: () => {} });
  });
  after(() => origin.close());

  test('GET / redirects to /graphql, where GraphiQL answers browsers', async () => {
    const base = origin.url.replace(/\/graphql$/, '');
    const redirect = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/graphql');
    const graphiql = await fetch(origin.url, { headers: { accept: 'text/html' } });
    assert.equal(graphiql.status, 200);
    assert.match(await graphiql.text(), /GraphiQL/);
  });

  test('GET /health answers 200 (used as the Render health check)', async () => {
    const base = origin.url.replace(/\/graphql$/, '');
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });

  test('a title longer than 200 characters is refused', async () => {
    const mutation = `mutation { updateBook(id: "2", title: "${'x'.repeat(201)}") { id } }`;
    const result = await (await post(origin.url, { query: mutation })).json();
    assert.equal(result.errors[0].extensions.code, 'BAD_USER_INPUT');
  });
});

describe('loadOriginConfig', () => {
  test('defaults: localhost only, port 4000, limits on', () => {
    assert.deepEqual(loadOriginConfig({}), {
      host: '127.0.0.1',
      port: 4000,
      delayMs: 0,
      maxBodyBytes: 16384,
      rateLimitPerMinute: 120,
      trustProxy: false,
    });
  });

  test('reads the settings a hosting platform provides', () => {
    const config = loadOriginConfig({ HOST: '0.0.0.0', PORT: '10000', TRUST_PROXY: 'true', RATE_LIMIT_PER_MINUTE: '60' });
    assert.equal(config.host, '0.0.0.0');
    assert.equal(config.port, 10000);
    assert.equal(config.trustProxy, true);
    assert.equal(config.rateLimitPerMinute, 60);
  });

  test('refuses invalid numbers', () => {
    assert.throws(() => loadOriginConfig({ PORT: 'abc' }), /PORT must be a non-negative integer/);
  });
});
