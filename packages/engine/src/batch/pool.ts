/** Concurrency primitives for the batch runner (Level-1 swarm parallelism).
 *
 *  Node is single-threaded per event-loop turn, so we don't need real mutexes —
 *  we need to bound how many async fixture tasks are in flight at once (rate-limit
 *  + memory control) and track cost atomically across them. */

/** Run `worker` over `items` with at most `concurrency` in flight at once.
 *  Results are returned in INPUT order regardless of completion order.
 *  `onSettled(index)` fires as each item completes (for progress + cost checks).
 *  `shouldStop()` is polled before scheduling each new item — return true to stop
 *  scheduling further work (in-flight tasks still finish). */
export async function runPool<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  worker: (item: TIn, index: number) => Promise<TOut>,
  hooks?: {
    onSettled?: (index: number, result: TOut) => void;
    shouldStop?: () => boolean;
  },
): Promise<Array<TOut | undefined>> {
  const results = new Array<TOut | undefined>(items.length);
  const width = Math.max(1, Math.min(concurrency, items.length || 1));
  let next = 0;
  let stopped = false;

  async function runner(): Promise<void> {
    while (true) {
      if (hooks?.shouldStop?.()) stopped = true;
      if (stopped) return;
      const i = next++;
      if (i >= items.length) return;
      const out = await worker(items[i]!, i);
      results[i] = out;
      hooks?.onSettled?.(i, out);
    }
  }

  await Promise.all(Array.from({ length: width }, () => runner()));
  return results;
}

/** Atomic cost tracker for the batch. Increment + ceiling check happen in a single
 *  synchronous call, so concurrent fixtures can't double-spend past the ceiling
 *  within the same event-loop turn. Because tasks run concurrently, the ceiling may
 *  be exceeded by up to (concurrency − 1) in-flight calls before scheduling halts —
 *  acceptable slack; new fixtures stop scheduling once `halted` is set. */
export class AtomicCostTracker {
  private _spent = 0;
  private _halted = false;

  constructor(
    private readonly _perCallUsd: number,
    private readonly _ceilingUsd: number | null,
  ) {}

  /** Record one billable call. Returns true if the ceiling is now reached/exceeded. */
  charge(): boolean {
    this._spent += this._perCallUsd;
    if (this._ceilingUsd !== null && this._spent >= this._ceilingUsd) this._halted = true;
    return this._halted;
  }

  get spent(): number { return this._spent; }
  get halted(): boolean { return this._halted; }
}
