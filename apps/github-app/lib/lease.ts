import { Redis } from "@upstash/redis";

/** One active worker per PR across all revisions and redeliveries. */
export interface LeaseStore {
  acquire(key: string, owner: string, seconds: number): Promise<boolean>;
  release(key: string, owner: string): Promise<void>;
}
export function redisLeaseStore(): LeaseStore {
  const redis = Redis.fromEnv();
  return {
    async acquire(key, owner, seconds) { return await redis.set(key, owner, { nx: true, ex: seconds }) === "OK"; },
    async release(key, owner) {
      await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", [key], [owner]);
    },
  };
}

export async function withReviewLease<T>(key: string, store: LeaseStore, work: () => Promise<T>): Promise<T> {
  const owner = crypto.randomUUID();
  // Must exceed the worker's enforced Vercel maxDuration (300s). A crashed
  // invocation cannot overlap its successor after the lease expires.
  if (!await store.acquire(`hunch:lease:${key}`, owner, 360)) throw new Error("PR review already active; retry later");
  try { return await work(); }
  finally { await store.release(`hunch:lease:${key}`, owner); }
}
