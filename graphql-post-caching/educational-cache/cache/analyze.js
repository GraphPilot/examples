// Analyzes a GraphQL request body and decides whether it may be cached.
//
// Everything here works on the parsed GraphQL AST, never on the raw query
// string. String matching ("does the query contain 'mutation'?") is wrong in
// both directions: it misses `  # comment\n mutation { ... }` edge cases and
// misfires on a field or operation called `mutationLog`. The AST is exact.

import {
  getOperationAST,
  getVariableValues,
  parse,
  print,
  separateOperations,
  TypeInfo,
  validate,
  visit,
  visitWithTypeInfo,
} from 'graphql';
import { lookupFieldPolicy } from './policy.js';

const INTROSPECTION_FIELDS = new Set(['__schema', '__type']);

/**
 * @returns one of
 *   { kind: 'bypass', reason, operationType }
 *   { kind: 'mutation', operationType, document, operation, variables }
 *   { kind: 'query', operationType, document, operation, variables, normalizedQuery, maxAge }
 */
export function analyzeGraphQLRequest({ schema, policy, body }) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return bypass(Array.isArray(body) ? 'batched-request' : 'invalid-body');
  }
  if (typeof body.query !== 'string' || body.query.trim() === '') {
    // Covers persisted-query requests that only send a hash. Supporting them
    // needs a hash-to-document store, which this example does not have.
    return bypass('missing-query');
  }

  let fullDocument;
  try {
    fullDocument = parse(body.query);
  } catch {
    return bypass('parse-error');
  }

  // Pick the operation the server will execute. With several operations in one
  // document, operationName decides; if it is missing or unknown, the request
  // is ambiguous and the origin will reject it.
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const operation = getOperationAST(fullDocument, operationName);
  if (!operation) return bypass('operation-not-found');
  const operationType = operation.operation; // 'query' | 'mutation' | 'subscription'

  // Reject documents that do not match the schema (unknown fields, wrong
  // arguments, ...). The origin would return an error for them anyway.
  if (validate(schema, fullDocument).length > 0) return bypass('invalid-document', operationType);

  // Keep only the selected operation and the fragments it uses. This is the
  // document the cache key and the response walk are based on.
  const document = separateOperations(fullDocument)[operation.name?.value ?? ''];

  // Coerce variables exactly like the server does. This applies defaults and
  // normalizes values ({"id": 1} and {"id": "1"} both become the ID "1").
  const rawVariables =
    body.variables && typeof body.variables === 'object' && !Array.isArray(body.variables)
      ? body.variables
      : {};
  const coerced = getVariableValues(schema, operation.variableDefinitions ?? [], rawVariables);
  if (coerced.errors) return bypass('invalid-variables', operationType);
  const variables = coerced.coerced;

  if (operationType === 'mutation') {
    return { kind: 'mutation', operationType, document, operation, variables };
  }
  if (operationType === 'subscription') return bypass('subscription', operationType);

  // Walk every selected field with its parent type and check it against the
  // public-field allowlist.
  const typeInfo = new TypeInfo(schema);
  let introspection = false;
  let notPublic = null;
  let maxAge = Infinity;

  visit(
    document,
    visitWithTypeInfo(typeInfo, {
      Field(node) {
        const fieldName = node.name.value;
        if (fieldName === '__typename') return; // Harmless meta field.
        if (INTROSPECTION_FIELDS.has(fieldName)) {
          introspection = true;
          return;
        }
        const typeName = typeInfo.getParentType()?.name;
        const fieldPolicy = lookupFieldPolicy(policy, typeName, fieldName);
        if (!fieldPolicy) {
          notPublic ??= `${typeName}.${fieldName}`;
          return;
        }
        if (typeof fieldPolicy.maxAge === 'number') maxAge = Math.min(maxAge, fieldPolicy.maxAge);
      },
    }),
  );

  if (introspection) return bypass('introspection', operationType);
  if (notPublic) return bypass(`non-public-field:${notPublic}`, operationType);

  return {
    kind: 'query',
    operationType,
    document,
    operation,
    variables,
    // print() produces canonical formatting: whitespace, comments and unused
    // operations in the original request no longer influence the cache key.
    normalizedQuery: print(document),
    maxAge,
  };
}

// operationType is included once it is known, so callers can, for example,
// reject a mutation sent with the safe QUERY method even if it is invalid.
function bypass(reason, operationType = null) {
  return { kind: 'bypass', reason, operationType };
}
