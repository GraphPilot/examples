// Creates the GraphQL Yoga origin server.
//
// `yoga` can be used in two ways:
//   - as a Node.js request listener: http.createServer(yoga)
//   - in-process with the Fetch API: yoga.fetch(request)  (used by the tests)

import { setTimeout as sleep } from 'node:timers/promises';
import { createYoga } from 'graphql-yoga';
import { createBookStore } from './data.js';
import { schema } from './schema.js';

/**
 * @param {object} [options]
 * @param {ReturnType<typeof createBookStore>} [options.store]
 * @param {number} [options.delayMs] Artificial latency per request, so a cache
 *   HIT is visibly faster than a request that reaches the origin. 0 disables it.
 */
export function createOrigin({ store = createBookStore(), delayMs = 0 } = {}) {
  const yoga = createYoga({
    schema,
    graphqlEndpoint: '/graphql',
    landingPage: false,
    // Yoga's own logging is off; origin/server.js logs one line per request.
    logging: false,
    context: async () => {
      if (delayMs > 0) await sleep(delayMs);
      return { store };
    },
  });

  return { yoga, store };
}
