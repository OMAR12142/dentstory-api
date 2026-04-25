/**
 * Simple In-Memory Cache with TTL (Time-To-Live)
 * Designed for high-frequency analytics data to reduce database load.
 */
class SimpleCache {
  constructor() {
    this.cache = new Map();
  }

  /**
   * Set a value in the cache with a specific TTL in seconds.
   */
  set(key, value, ttlSeconds = 300) {
    const expiry = Date.now() + ttlSeconds * 1000;
    this.cache.set(key, { value, expiry });
  }

  /**
   * Get a value from the cache. Returns null if expired or missing.
   */
  get(key) {
    const cached = this.cache.get(key);
    if (!cached) return null;

    if (Date.now() > cached.expiry) {
      this.cache.delete(key);
      return null;
    }

    return cached.value;
  }

  /**
   * Delete a specific key from the cache
   */
  del(key) {
    this.cache.delete(key);
  }

  /**
   * Clear the entire cache
   */
  clear() {
    this.cache.clear();
  }
}

// Global instance for the app
const analyticsCache = new SimpleCache();

module.exports = { analyticsCache };
