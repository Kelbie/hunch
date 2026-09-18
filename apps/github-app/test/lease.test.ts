import { expect, test } from "bun:test";
import { leaseCredentials, withReviewLease, type LeaseStore } from "../lib/lease.js";

test("lease credentials accept Marketplace naming without mixing credentials from different stores", () => {
  expect(leaseCredentials({ KV_REST_API_URL: "https://marketplace.example", KV_REST_API_TOKEN: "marketplace" })).toEqual({ url: "https://marketplace.example", token: "marketplace" });
  expect(leaseCredentials({ UPSTASH_REDIS_REST_URL: "https://other.example", KV_REST_API_TOKEN: "marketplace" })).toBeNull();
});

test("overlapping PR jobs cannot both enter publication; errors release only their lease", async () => {
  const owners = new Map<string, string>();
  const store: LeaseStore = {
    async acquire(key, owner, seconds) { expect(seconds).toBeGreaterThan(300); if (owners.has(key)) return false; owners.set(key, owner); return true; },
    async release(key, owner) { if (owners.get(key) === owner) owners.delete(key); },
  };
  let release!: () => void;
  let entered!: () => void;
  const active = new Promise<void>((resolve) => { entered = resolve; });
  const first = withReviewLease("repo:1", store, async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); });
  await active;
  await expect(withReviewLease("repo:1", store, async () => { throw new Error("must not enter"); })).rejects.toThrow("already active");
  release(); await first;
  await expect(withReviewLease("repo:1", store, async () => { throw new Error("worker failed"); })).rejects.toThrow("worker failed");
  expect(owners.size).toBe(0);
  expect(await withReviewLease("repo:1", store, async () => "recovered")).toBe("recovered");
});
