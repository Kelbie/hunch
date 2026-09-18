import { Redis } from "@upstash/redis";
import { leaseCredentials } from "./lease.js";

/**
 * A public App reviews repositories its operator does not own and pays for every review out of one
 * AI Gateway balance, so one installation must not be able to spend the whole budget. Unset means
 * unlimited, which is right for an operator running Hunch only for their own account.
 */
export function dailyReviewLimit(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.HUNCH_DAILY_REVIEWS_PER_INSTALL?.trim();
  if (!raw) return null;
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("HUNCH_DAILY_REVIEWS_PER_INSTALL must be a positive integer");
  return limit;
}

export interface QuotaDecision {
  allowed: boolean;
  /** Reviews charged to this installation today, including this one. */
  used: number;
  limit: number;
}
export interface Quota {
  /**
   * Charges one review. `unit` identifies the review itself, so a queue retry of work already paid
   * for is never charged again and is never refused for a limit reached since.
   */
  consume(installationId: number, unit: string): Promise<QuotaDecision>;
}

/** Counters outlive a UTC day so a review retried near midnight still finds the day it was charged to. */
const RETENTION_SECONDS = 172_800;

export function redisQuota(limit: number, clock: () => Date = () => new Date()): Quota {
  const credentials = leaseCredentials();
  if (!credentials) throw new Error("Missing Redis REST credentials");
  return quota(limit, new Redis(credentials), clock);
}

/** The Redis surface this needs, so tests exercise the charging rules rather than a client. */
export interface QuotaRedis {
  set(key: string, value: string, opts: { nx: true; ex: number }): Promise<unknown>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  get(key: string): Promise<unknown>;
}

export function quota(limit: number, redis: QuotaRedis, clock: () => Date = () => new Date()): Quota {
  return {
    async consume(installationId, unit) {
      const day = clock().toISOString().slice(0, 10);
      const counter = `hunch:quota:${installationId}:${day}`;
      const first = await redis.set(`hunch:quota:charged:${installationId}:${unit}`, day, { nx: true, ex: RETENTION_SECONDS });
      if (first !== "OK") return { allowed: true, used: Number(await redis.get(counter) ?? 0), limit };
      const used = await redis.incr(counter);
      if (used === 1) await redis.expire(counter, RETENTION_SECONDS);
      return { allowed: used <= limit, used, limit };
    },
  };
}
