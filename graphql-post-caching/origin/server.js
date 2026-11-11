// Starts the Book GraphQL origin on its own. No cache, no GraphPilot account.
//
//   npm run origin            ->  http://127.0.0.1:4000/graphql
//
// Every request that reaches this server is logged. A response served from a
// cache in front of it (GraphPilot or the educational cache) never shows up
// here, which makes cache HITs easy to see.
//
// Because the origin may run on a public URL (a tunnel, Render), the HTTP layer
// below adds two demo safeguards in front of GraphQL Yoga:
//   - a request body limit (MAX_BODY_BYTES), answered with 413, and
//   - a per-client request limit (RATE_LIMIT_PER_MINUTE), answered with 429.
// The data itself lives in memory and resets whenever the process restarts.

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createOrigin } from './create-origin.js';

const DEFAULTS = {
  host: '127.0.0.1',
  port: 4000,
  delayMs: 0,
  maxBodyBytes: 16 * 1024,
  rateLimitPerMinute: 120,
  trustProxy: false,
};

export async function startOrigin(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const log = options.log ?? console.log;
  const { yoga, store } = createOrigin({ delayMs: config.delayMs });
  const server = createServer(createListener({ yoga, config, log, now: options.now }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  const displayHost = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
  return {
    url: `http://${displayHost}:${server.address().port}/graphql`,
    store,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The node:http listener: limits, a redirect from / to /graphql, then GraphQL Yoga. */
export function createListener({ yoga, config, log, now = () => Date.now() }) {
  const limiter = createRateLimiter(config.rateLimitPerMinute, now);

  return async (req, res) => {
    const time = new Date(now()).toISOString().slice(11, 19);

    if (!limiter.allow(clientAddress(req, config.trustProxy))) {
      log(`${time} ${req.method} ${req.url} refused: rate limit`);
      return sendError(res, 429, 'Too many requests. Try again in a minute.', { 'retry-after': '60' });
    }
    if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
      res.writeHead(302, { location: '/graphql' });
      return res.end();
    }

    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > config.maxBodyBytes) {
      log(`${time} ${req.method} ${req.url} refused: body too large`);
      return sendError(res, 413, `Request body larger than ${config.maxBodyBytes} bytes.`);
    }
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req, config.maxBodyBytes);
    if (body === null) {
      log(`${time} ${req.method} ${req.url} refused: body too large`);
      return sendError(res, 413, `Request body larger than ${config.maxBodyBytes} bytes.`);
    }

    // Health checks (Render probes /health) would drown out the demo's log.
    if (req.url !== '/health') log(`${time} ${req.method} ${req.url} reached the origin`);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
      else if (value !== undefined) headers.set(name, value);
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const response = await yoga.fetch(url, { method: req.method, headers, body });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}

// A fixed one-minute window per client address. Small and good enough for a
// demo; it is not shared between instances and resets on restart.
function createRateLimiter(perMinute, now) {
  let windowStart = now();
  let counts = new Map();
  return {
    allow(key) {
      if (!perMinute) return true; // 0 switches the limit off.
      if (now() - windowStart >= 60_000) {
        windowStart = now();
        counts = new Map();
      }
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return count <= perMinute;
    },
  };
}

// Behind a proxy (such as Render's load balancer), every connection comes from
// the proxy. With TRUST_PROXY set, the LAST X-Forwarded-For entry is used: the
// address the proxy directly in front of this server saw. Earlier entries can be
// sent by the client itself, so they are never trusted. Without TRUST_PROXY, or
// without the header, the connection's own address counts.
function clientAddress(req, trustProxy) {
  if (trustProxy) {
    const entries = String(req.headers['x-forwarded-for'] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (entries.length > 0) return entries.at(-1);
  }
  return req.socket.remoteAddress ?? 'unknown';
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendError(res, status, message, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify({ errors: [{ message }] }));
}

/** Reads the origin's settings from environment variables. */
export function loadOriginConfig(env = process.env) {
  const integer = (name, fallback) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
    return value;
  };
  return {
    host: env.HOST || DEFAULTS.host,
    port: integer('PORT', DEFAULTS.port),
    delayMs: integer('ORIGIN_DELAY_MS', DEFAULTS.delayMs),
    maxBodyBytes: integer('MAX_BODY_BYTES', DEFAULTS.maxBodyBytes),
    rateLimitPerMinute: integer('RATE_LIMIT_PER_MINUTE', DEFAULTS.rateLimitPerMinute),
    trustProxy: env.TRUST_PROXY === 'true',
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let config;
  try {
    config = loadOriginConfig();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const origin = await startOrigin(config);
  console.log(`Book GraphQL origin: ${origin.url}  (no cache in front)`);
  console.log(
    `Listening on ${config.host}:${config.port}. Origin delay ${config.delayMs} ms, ` +
      `body limit ${config.maxBodyBytes} bytes, ${config.rateLimitPerMinute || 'no'} requests per minute per client.`,
  );
  console.log('Data is in memory; restart to reset it. Ctrl+C to stop.');
  const shutdown = async () => {
    await origin.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
