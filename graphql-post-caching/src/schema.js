// The GraphQL origin: schema and resolvers.
//
// The origin knows nothing about caching. It is an ordinary GraphQL API with
// public book reads and one mutation that changes data.

import { GraphQLError } from 'graphql';
import { createSchema } from 'graphql-yoga';

export const typeDefs = /* GraphQL */ `
  type Book {
    id: ID!
    title: String!
    author: String!
    category: String!
    "Price in cents"
    price: Int!
  }

  type Query {
    "All books, or the books of one category."
    books(category: String): [Book!]!
    "One book, or null when it does not exist."
    book(id: ID!): Book
  }

  type Mutation {
    "Changes a book's title. Cached responses that contain this book become outdated."
    updateBook(id: ID!, title: String!): Book!
  }
`;

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
      const book = store.updateTitle(id, title);
      if (!book) {
        throw new GraphQLError(`Book ${id} not found`, { extensions: { code: 'NOT_FOUND' } });
      }
      return book;
    },
  },
};

export const schema = createSchema({ typeDefs, resolvers });
