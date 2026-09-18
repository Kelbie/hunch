import { expect, test } from "bun:test";
import { dailyReviewLimit, quota, type QuotaRedis } from "../lib/quota.js";

/** Upstash's REST semantics for the calls quota makes: SET NX returns "OK" only the first time. */
function fakeRedis(): QuotaRedis & { keys: Map<string, string>; expiries: Map<string, number> } {
  const keys = new Map<string, string>();
  const expiries = new Map<string, number>();
  return {
    keys, expiries,
    async set(key, value, opts) { if (opts.nx && keys.has(key)) return null; keys.set(key, value); expiries.set(key, opts.ex); return "OK"; },
    async incr(key) { const next = Number(keys.get(key) ?? 0) + 1; keys.set(key, String(next)); return next; },
    async expire(key, seconds) { expiries.set(key, seconds); return 1; },
    async get(key) { return keys.get(key) ?? null; },
  };
}

test("an unset limit leaves self-hosted operators unlimited, and a nonsense limit fails loudly", () => {
  expect(dailyReviewLimit({})).toBeNull();
  expect(dailyReviewLimit({ HUNCH_DAILY_REVIEWS_PER_INSTALL: "  " })).toBeNull();
  expect(dailyReviewLimit({ HUNCH_DAILY_REVIEWS_PER_INSTALL: "25" })).toBe(25);
  for (const bad of ["0", "-1", "3.5", "lots"]) {
    expect(() => dailyReviewLimit({ HUNCH_DAILY_REVIEWS_PER_INSTALL: bad })).toThrow("positive integer");
  }
});

test("one installation cannot spend past its daily limit, and each installation is counted apart", async () => {
  const redis = fakeRedis();
  const q = quota(2, redis, () => new Date("2026-09-18T09:00:00Z"));
  expect(await q.consume(1, "repo:1:aaa")).toMatchObject({ allowed: true, used: 1, limit: 2 });
  expect(await q.consume(1, "repo:2:bbb")).toMatchObject({ allowed: true, used: 2 });
  expect(await q.consume(1, "repo:3:ccc")).toMatchObject({ allowed: false, used: 3 });
  // A second installation has its own budget and is unaffected by the first one's spending.
  expect(await q.consume(2, "other:1:ddd")).toMatchObject({ allowed: true, used: 1 });
});

test("a retry of a review already charged is free and is never refused by a limit reached since", async () => {
  const redis = fakeRedis();
  const q = quota(1, redis, () => new Date("2026-09-18T09:00:00Z"));
  expect(await q.consume(7, "repo:1:aaa")).toMatchObject({ allowed: true, used: 1 });
  // The installation is now at its limit, but this delivery is a retry of work already paid for.
  expect(await q.consume(7, "repo:1:aaa")).toMatchObject({ allowed: true });
  expect(await q.consume(7, "repo:2:bbb")).toMatchObject({ allowed: false, used: 2 });
  expect(await q.consume(7, "repo:1:aaa")).toMatchObject({ allowed: true });
});

test("budget is per UTC day and counters outlive the day so a midnight retry still resolves", async () => {
  const redis = fakeRedis();
  let today = "2026-09-18T23:59:00Z";
  const q = quota(1, redis, () => new Date(today));
  expect(await q.consume(3, "repo:1:aaa")).toMatchObject({ allowed: true, used: 1 });
  expect(await q.consume(3, "repo:2:bbb")).toMatchObject({ allowed: false });
  today = "2026-09-19T00:01:00Z";
  expect(await q.consume(3, "repo:3:ccc")).toMatchObject({ allowed: true, used: 1 });
  for (const [key, seconds] of redis.expiries) expect(seconds).toBeGreaterThan(86_400);
  expect([...redis.keys.keys()].some((k) => k.includes("2026-09-18"))).toBe(true);
});
