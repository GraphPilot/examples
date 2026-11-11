// Deterministic cache keys.
//
// Two requests share a cache entry only if they would produce the same
// response. For this API that depends on:
//   - the host and path (one cache may front several hostnames or tenants;
//     they must never share entries),
//   - the normalized operation (selected operation + its fragments, printed),
//   - the coerced variables.
//
// The HTTP method is deliberately NOT part of the key: the same read sent as
// POST or as QUERY produces the same response and shares one entry.
//
// If your origin reads other request context (a tenant header, a locale, a
// feature flag), that context must be added to the key, or requests that
// carry it must bypass the cache.
//
// Everything is serialized with sorted object keys, so {"a":1,"b":2} and
// {"b":2,"a":1} produce the same key, then hashed with SHA-256.

import { createHash } from 'node:crypto';

export function createCacheKey({ host, path, normalizedQuery, variables }) {
  const material = canonicalJson({ version: 1, host, path, query: normalizedQuery, variables });
  return createHash('sha256').update(material).digest('hex');
}

/** JSON.stringify with recursively sorted object keys. */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key]);
    return sorted;
  }
  return value;
}
