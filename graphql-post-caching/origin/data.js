// In-memory data for the demo origin. No database, no external services.
//
// The seed matches the bookshop used in the GraphPilot demo videos. Every call
// to createBookStore() returns an independent copy, so tests and server
// restarts always start from the same state.

const SEED_BOOKS = [
  { id: '1', title: 'The Pragmatic Programmer', author: 'Hunt & Thomas', category: 'software', price: 3990 },
  { id: '2', title: 'Designing Data-Intensive Applications', author: 'Martin Kleppmann', category: 'software', price: 4590 },
  { id: '3', title: 'Clean Architecture', author: 'Robert C. Martin', category: 'software', price: 3490 },
  { id: '4', title: 'Dune', author: 'Frank Herbert', category: 'scifi', price: 1290 },
];

export function createBookStore() {
  const books = new Map(SEED_BOOKS.map((book) => [book.id, { ...book }]));

  return {
    list(category) {
      const all = [...books.values()];
      return category ? all.filter((book) => book.category === category) : all;
    },
    get(id) {
      return books.get(id) ?? null;
    },
    /** Changes a book's title and returns the book, or null if it does not exist. */
    updateTitle(id, title) {
      const book = books.get(id);
      if (!book) return null;
      book.title = title;
      return book;
    },
  };
}
