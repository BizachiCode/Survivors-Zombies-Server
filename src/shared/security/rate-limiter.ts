/** Port: answers whether `key` may perform one more action now (sync in memory, async when backed by Redis). */
export interface RateLimiter {
  allow(key: string): boolean | Promise<boolean>;
}

export type TokenBucketOptions = {
  /** Tokens refilled per interval. */
  tokensPerInterval: number;
  intervalMs: number;
  /** Bucket capacity (defaults to tokensPerInterval). */
  burst?: number;
  /** Clock (ms) for tests. */
  now?: () => number;
};

/** In-memory token bucket keyed by an arbitrary string (user id, IP...). State is per process. */
export class TokenBucketRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; last: number }>();
  private readonly capacity: number;
  private readonly now: () => number;
  private sweepCounter = 0;

  constructor(private readonly options: TokenBucketOptions) {
    this.capacity = Math.max(1, options.burst ?? options.tokensPerInterval);
    this.now = options.now ?? Date.now;
  }

  allow(key: string): boolean {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, last: now };
    const elapsed = Math.max(0, now - bucket.last);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (elapsed / this.options.intervalMs) * this.options.tokensPerInterval);
    bucket.last = now;

    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    this.buckets.set(key, bucket);

    if (++this.sweepCounter >= 1000) this.sweep(now);
    return allowed;
  }

  /** Drops full buckets so idle keys don't accumulate forever. */
  private sweep(now: number): void {
    this.sweepCounter = 0;
    for (const [key, bucket] of this.buckets) {
      const refilled = bucket.tokens + ((now - bucket.last) / this.options.intervalMs) * this.options.tokensPerInterval;
      if (refilled >= this.capacity) this.buckets.delete(key);
    }
  }
}

/** Limiter that never blocks (tests / disabled buckets). */
export const unlimited: RateLimiter = { allow: () => true };
