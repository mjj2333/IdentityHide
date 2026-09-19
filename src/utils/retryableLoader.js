/**
 * Memoise an async load — but never memoise a failure.
 *
 * Concurrent callers share the one in-flight attempt and a successful result
 * is reused forever, like a plain cached promise. A REJECTED attempt is
 * dropped from the cache, so the next caller tries again instead of being
 * handed the same stale rejection for the rest of the page's life (which is
 * what a bare `pending = loadFn()` cache does: one flaky network response and
 * the feature stays broken until the user reloads).
 */
export function createRetryableLoader(loadFn) {
  let pending = null;
  return {
    load() {
      if (!pending) {
        // Start synchronously; a synchronous throw becomes a rejection.
        let attempt;
        try { attempt = Promise.resolve(loadFn()); } catch (err) { attempt = Promise.reject(err); }
        pending = attempt;
        // Only clear the cache if it still holds THIS attempt — a reset() (or a
        // newer attempt) in the meantime must not be clobbered.
        attempt.catch(() => { if (pending === attempt) pending = null; });
      }
      return pending;
    },
    /** Forget the cached result/attempt; the next load() starts fresh. */
    reset() {
      pending = null;
    },
  };
}
