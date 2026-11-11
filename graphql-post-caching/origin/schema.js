// The executable schema of the Book API: origin/schema.graphql plus resolvers.
//
// The origin knows nothing about caching. It is an ordinary GraphQL API with
// public book reads and one mutation that changes data.

import { readFileSync } from 'node:fs';
import { GraphQLError } from 'graphql';
import { createSchema } from 'graphql-yoga';

export const typeDefs = readFileSync(new URL('./schema.graphql', import.meta.url), 'utf8');

const MAX_TITLE_LENGTH = 200;

export const resolvers = {
  Query: {
    books: (_parent, { category }, { store }) => store.list(category),
    book: (_parent, { id }, { store }) => store.get(id),
  },
  Mutation: {
    updateBook(_parent, { id, title }, { store }) {
      if (title.trim() === '') {
        throw new GraphQLError('title must not be empty', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      // The origin may run on a public URL where anyone can send mutations:
      // keep what one request can store small.
      if (title.length > MAX_TITLE_LENGTH) {
        throw new GraphQLError(`title must be at most ${MAX_TITLE_LENGTH} characters`, {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      const book = store.updateTitle(id, title);
      if (!book) {
        throw new GraphQLError(`Book ${id} not found`, { extensions: { code: 'NOT_FOUND' } });
      }
      return book;
    },
  },
};

export const schema = createSchema({ typeDefs, resolvers });
