// Starts two HTTP servers in one process:
//
//   client ──► cache proxy (:4000) ──► GraphQL origin (:4001)
//
// The origin is reachable directly as well, which the README uses to show how
// a cache serves stale data when the origin changes behind its back.

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createCachingProxy } from './cache/handler.js';
import { loadConfig } from './config.js';
import { createHttpOrigin, toNodeListener } from './http.js';
import { createOrigin } from './origin.js';
import { schema } from './schema.js';

export async function startServers(config = loadConfig(), { log = console.log } = {}) {
  const { yoga, store } = createOrigin({ delayMs: config.originDelayMs });
  const originServer = createServer(yoga);
  await listen(originServer, config.originPort, config.host);
  const originUrl = `http://${config.host}:${originServer.address().port}`;

  const proxy = createCachingProxy({
    origin: createHttpOrigin(originUrl),
    schema,
    ttlSeconds: config.ttlSeconds,
    maxEntries: config.maxEntries,
    log: (line) => log(`[cache] ${line}`),
  });
  const proxyServer = createServer(toNodeListener(proxy.handle));
  await listen(proxyServer, config.port, config.host);
  const proxyUrl = `http://${config.host}:${proxyServer.address().port}`;

  return {
    proxyUrl,
    originUrl,
    proxy,
    store,
    async close() {
      await Promise.all([close(proxyServer), close(originServer)]);
    },
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

// Run only when started directly (`npm start`), not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const servers = await startServers(config);
  console.log(`Cache proxy:    ${servers.proxyUrl}/graphql   (send requests here)`);
  console.log(`GraphQL origin: ${servers.originUrl}/graphql   (bypasses the cache)`);
  console.log(`Cache stats:    ${servers.proxyUrl}/_cache/stats`);
  console.log(
    `TTL ${config.ttlSeconds}s, max ${config.maxEntries} entries, origin delay ${config.originDelayMs}ms. Ctrl+C to stop.`,
  );
  const shutdown = async () => {
    await servers.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
