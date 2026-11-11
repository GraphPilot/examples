// Finds the entities (typed objects with an id) inside a GraphQL response.
//
// The cache uses this for tag-based invalidation:
//   - a cached query response is tagged with every entity it contains,
//   - a mutation response tells the cache which entities just changed.
//
// The walk follows the operation's selection set and the schema in parallel
// with the JSON response, so it knows the GraphQL type of every object even
// though the JSON itself carries no type information.

import {
  getNamedType,
  isAbstractType,
  isListType,
  isNonNullType,
  isObjectType,
  Kind,
  typeFromAST,
} from 'graphql';

/**
 * @returns {Array<{ typename: string, id: string | null }>}
 *   id is null when the response does not include the object's id field.
 */
export function collectEntities({ schema, document, operation, data }) {
  const rootType = schema.getRootType(operation.operation);
  if (!rootType || data == null) return [];

  const fragments = new Map(
    document.definitions
      .filter((d) => d.kind === Kind.FRAGMENT_DEFINITION)
      .map((d) => [d.name.value, d]),
  );

  const entities = [];
  walkObject({ schema, fragments, entities }, rootType, [operation.selectionSet], data, true);
  return entities;
}

function walkValue(ctx, type, selectionSets, value) {
  if (value == null) return;
  if (isNonNullType(type)) return walkValue(ctx, type.ofType, selectionSets, value);
  if (isListType(type)) {
    if (Array.isArray(value)) for (const item of value) walkValue(ctx, type.ofType, selectionSets, item);
    return;
  }

  let objectType = type;
  if (isAbstractType(type)) {
    // Interfaces and unions: the concrete type is only known if the response
    // includes __typename. Without it, record an unknown entity so callers can
    // fall back to conservative invalidation.
    objectType = value.__typename ? ctx.schema.getType(value.__typename) : null;
    if (!isObjectType(objectType)) {
      ctx.entities.push({ typename: type.name, id: null });
      return;
    }
  }
  if (isObjectType(objectType)) walkObject(ctx, objectType, selectionSets, value, false);
}

function walkObject(ctx, type, selectionSets, value, isRoot) {
  const fields = collectFields(ctx, type, selectionSets);

  if (!isRoot) {
    // The id is only known if the client selected it (possibly aliased, as in
    // `productId: id`). Without it, the entity is recorded with id null.
    const idField = [...fields.values()].find((field) => field.name === 'id');
    const id = idField ? value[idField.responseKey] : undefined;
    ctx.entities.push({ typename: type.name, id: id == null ? null : String(id) });
  }

  for (const field of fields.values()) {
    const fieldDef = type.getFields()[field.name];
    if (!fieldDef || field.selectionSets.length === 0) continue; // Scalars, __typename.
    if (!isObjectType(getNamedType(fieldDef.type)) && !isAbstractType(getNamedType(fieldDef.type))) continue;
    walkValue(ctx, fieldDef.type, field.selectionSets, value[field.responseKey]);
  }
}

/**
 * Flattens fields, inline fragments and fragment spreads that apply to `type`.
 * Returns Map<responseKey, { name, responseKey, selectionSets }>.
 */
function collectFields(ctx, type, selectionSets, result = new Map(), visited = new Set()) {
  for (const selectionSet of selectionSets) {
    for (const selection of selectionSet.selections) {
      if (selection.kind === Kind.FIELD) {
        const name = selection.name.value;
        const responseKey = selection.alias?.value ?? name;
        const entry = result.get(responseKey) ?? { name, responseKey, selectionSets: [] };
        if (selection.selectionSet) entry.selectionSets.push(selection.selectionSet);
        result.set(responseKey, entry);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        if (fragmentApplies(ctx.schema, selection.typeCondition, type)) {
          collectFields(ctx, type, [selection.selectionSet], result, visited);
        }
      } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
        const name = selection.name.value;
        const fragment = ctx.fragments.get(name);
        if (!fragment || visited.has(name)) continue;
        visited.add(name);
        if (fragmentApplies(ctx.schema, fragment.typeCondition, type)) {
          collectFields(ctx, type, [fragment.selectionSet], result, visited);
        }
      }
    }
  }
  return result;
}

function fragmentApplies(schema, typeCondition, type) {
  if (!typeCondition) return true;
  const conditionType = typeFromAST(schema, typeCondition);
  if (!conditionType) return false;
  if (conditionType === type) return true;
  return isAbstractType(conditionType) && schema.isSubType(conditionType, type);
}
