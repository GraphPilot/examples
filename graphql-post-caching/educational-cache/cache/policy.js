// Cache policy: which fields are public and how long they may be cached.
//
// This is an ALLOWLIST. A query is cacheable only if every field it selects is
// listed here. Anything not listed (for example a field added to the schema
// later, or a field that depends on who is asking) makes the request bypass
// the cache. Default-deny is the safe choice: forgetting to list a new public
// field costs a cache miss, forgetting to exclude a new private field leaks data.
//
// `maxAge` (seconds) is optional. The effective TTL of a response is the
// smallest maxAge of all selected fields, capped by the configured default TTL.

export const cachePolicy = {
  Query: {
    books: {},
    book: {},
  },
  Book: {
    id: {},
    title: {},
    author: {},
    category: {},
    price: {},
  },
};

/** Returns the policy for `Type.field`, or undefined when it is not public. */
export function lookupFieldPolicy(policy, typeName, fieldName) {
  return Object.hasOwn(policy, typeName) && Object.hasOwn(policy[typeName], fieldName)
    ? policy[typeName][fieldName]
    : undefined;
}
