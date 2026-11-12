// Reads the educational cache's configuration from environment variables.
// All values have defaults, so `npm run educational` works without any setup.
//
// The defaults are tuned for the walkthrough and the blog article: a 5 second
// TTL, so an entry visibly expires, and 400 ms of origin latency, so a HIT is
// visibly faster than a MISS. Environment variables override them.

export function loadConfig(env = process.env) {
  return {
    host: env.HOST ?? '127.0.0.1',
    port: integer(env, 'PORT', 4100, 0),
    originPort: integer(env, 'ORIGIN_PORT', 4101, 0),
    ttlSeconds: integer(env, 'CACHE_TTL_SECONDS', 5, 1),
    maxEntries: integer(env, 'CACHE_MAX_ENTRIES', 100, 1),
    originDelayMs: integer(env, 'ORIGIN_DELAY_MS', 400, 0),
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
