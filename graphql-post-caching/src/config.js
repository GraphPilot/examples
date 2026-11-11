// Reads configuration from environment variables. All values have defaults,
// so `npm start` works without any setup.

export function loadConfig(env = process.env) {
  return {
    host: env.HOST ?? '127.0.0.1',
    port: integer(env, 'PORT', 4000, 0),
    originPort: integer(env, 'ORIGIN_PORT', 4001, 0),
    ttlSeconds: integer(env, 'CACHE_TTL_SECONDS', 30, 1),
    maxEntries: integer(env, 'CACHE_MAX_ENTRIES', 100, 1),
    originDelayMs: integer(env, 'ORIGIN_DELAY_MS', 0, 0),
  };
}

function integer(env, name, fallback, min) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return value;
}
