/** Per-key serialized transaction lock.
 *
 *  The storage adapters expose get/set, but the common read-modify-write pattern
 *  (`get(key) → append → set(key)`) is NOT atomic: under concurrent fixture
 *  processing two callers can both read the same array, both append, and both
 *  write — silently dropping one entry. A plain write queue does not fix this
 *  because the race is BETWEEN the read and the write.
 *
 *  withKeyLock serializes the entire transaction per key. Different keys run
 *  concurrently; same-key transactions queue behind each other. Single-process,
 *  single-event-loop only (matches ORACLE's worker model) — not cross-process. */

const _chains = new Map<string, Promise<unknown>>();

/** Run `fn` with exclusive access to `key`. Transactions on the same key are
 *  serialized in call order; transactions on different keys run concurrently.
 *  The lock is released when `fn`'s promise settles (resolve OR reject). */
export function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = _chains.get(key) ?? Promise.resolve();
  // Chain after the prior transaction regardless of how it settled.
  const next = prior.then(fn, fn);
  // Store a swallowed-error tail so one failure doesn't reject every future waiter.
  _chains.set(key, next.then(() => undefined, () => undefined));
  return next;
}

/** Test/utility helper — clears all lock chains. Safe to call between batches. */
export function _resetKeyLocks(): void {
  _chains.clear();
}
