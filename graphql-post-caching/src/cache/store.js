// A bounded in-memory response cache with TTL expiry and tag-based invalidation.
//
// - Bounded: at most `maxEntries` entries. When full, the least recently used
//   entry is evicted. Without a bound, every distinct variables object would
//   add an entry until the process runs out of memory.
// - TTL: every entry has an absolute expiry time. Expired entries are never
//   served and are removed lazily on lookup or when the cache needs space.
// - Tags: every entry carries tags (e.g. "Product:1"). invalidateTags() removes
//   all entries that carry any of the given tags.
//
// A JavaScript Map keeps insertion order, which makes it a compact LRU: on
// every hit the entry is re-inserted at the end, so the first key is always
// the least recently used one.
//
// EDUCATIONAL: this cache lives in one process. It is lost on restart and not
// shared between instances. Production systems need a shared or distributed
// store, request collapsing, and metrics.

export class ResponseCache {
  #entries = new Map(); // key -> entry
  #tagIndex = new Map(); // tag -> Set<key>
  #now;
  #stats = { hits: 0, misses: 0, evictions: 0, expirations: 0, invalidations: 0 };

  constructor({ maxEntries, now = () => Date.now() }) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError('maxEntries must be a positive integer');
    }
    this.maxEntries = maxEntries;
    this.#now = now;
  }

  get size() {
    return this.#entries.size;
  }

  /** Returns a fresh entry or undefined. Counts the hit or miss. */
  get(key) {
    const entry = this.#entries.get(key);
    if (!entry) {
      this.#stats.misses++;
      return undefined;
    }
    if (entry.expiresAt <= this.#now()) {
      this.#delete(key);
      this.#stats.expirations++;
      this.#stats.misses++;
      return undefined;
    }
    // Mark as most recently used.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    this.#stats.hits++;
    return { ...entry, ageSeconds: Math.floor((this.#now() - entry.storedAt) / 1000) };
  }

  /** Stores a response body. `tags` is an iterable of strings. */
  set(key, { body, contentType, ttlSeconds, tags = [] }) {
    if (this.#entries.has(key)) this.#delete(key);
    this.#makeRoom();

    const storedAt = this.#now();
    const entry = {
      key,
      body,
      contentType,
      storedAt,
      expiresAt: storedAt + ttlSeconds * 1000,
      ttlSeconds,
      tags: new Set(tags),
    };
    this.#entries.set(key, entry);
    for (const tag of entry.tags) {
      if (!this.#tagIndex.has(tag)) this.#tagIndex.set(tag, new Set());
      this.#tagIndex.get(tag).add(key);
    }
  }

  /** Removes every entry that carries at least one of `tags`. Returns the count. */
  invalidateTags(tags) {
    const keys = new Set();
    for (const tag of tags) for (const key of this.#tagIndex.get(tag) ?? []) keys.add(key);
    for (const key of keys) this.#delete(key);
    this.#stats.invalidations += keys.size;
    return keys.size;
  }

  /** Removes everything. Returns the number of removed entries. */
  clear() {
    const count = this.#entries.size;
    this.#entries.clear();
    this.#tagIndex.clear();
    this.#stats.invalidations += count;
    return count;
  }

  stats() {
    return { size: this.#entries.size, maxEntries: this.maxEntries, ...this.#stats };
  }

  #makeRoom() {
    if (this.#entries.size < this.maxEntries) return;

    // Prefer dropping expired entries over evicting live ones.
    const now = this.#now();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#delete(key);
        this.#stats.expirations++;
      }
    }
    // Then evict least recently used entries until there is room.
    while (this.#entries.size >= this.maxEntries) {
      const oldestKey = this.#entries.keys().next().value;
      this.#delete(oldestKey);
      this.#stats.evictions++;
    }
  }

  #delete(key) {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#entries.delete(key);
    for (const tag of entry.tags) {
      const keys = this.#tagIndex.get(tag);
      keys?.delete(key);
      if (keys?.size === 0) this.#tagIndex.delete(tag);
    }
  }
}
