import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../../educational-cache/config.js';

test('defaults match the walkthrough: TTL 5 s, 400 ms origin delay', () => {
  assert.deepEqual(loadConfig({}), {
    host: '127.0.0.1',
    port: 4100,
    originPort: 4101,
    ttlSeconds: 5,
    maxEntries: 100,
    originDelayMs: 400,
  });
});

test('environment variables override the defaults', () => {
  const config = loadConfig({ CACHE_TTL_SECONDS: '30', ORIGIN_DELAY_MS: '0' });
  assert.equal(config.ttlSeconds, 30);
  assert.equal(config.originDelayMs, 0);
});
