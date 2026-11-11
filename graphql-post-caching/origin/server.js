// Starts the Book GraphQL origin on its own. No cache, no GraphPilot account.
//
//   npm run origin            ->  http://127.0.0.1:4000/graphql
//
// Every request that reaches this server is logged. A response served from a
// cache in front of it (GraphPilot or the educational cache) never shows up
// here, which makes cache HITs easy to see.

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createOrigin } from './create-origin.js';

export async function startOrigin({ host = '127.0.0.1', port = 4000, delayMs = 0, log = console.log } = {}) {
  const { yoga, store } = createOrigin({ delayMs });
  const server = createServer((req, res) => {
    log(`${new Date().toISOString().slice(11, 19)} ${req.method} ${req.url} reached the origin`);
    return yoga(req, res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return {
    url: `http://${host}:${server.address().port}/graphql`,
    store,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 4000);
  const delayMs = Number(process.env.ORIGIN_DELAY_MS ?? 0);
  if (!Number.isInteger(port) || port < 0 || !Number.isInteger(delayMs) || delayMs < 0) {
    console.error('PORT and ORIGIN_DELAY_MS must be non-negative integers.');
    process.exit(1);
  }
  const origin = await startOrigin({ host, port, delayMs });
  console.log(`Book GraphQL origin: ${origin.url}  (no cache in front)`);
  console.log(`Origin delay ${delayMs} ms. Data is in memory; restart to reset it. Ctrl+C to stop.`);
  const shutdown = async () => {
    await origin.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
