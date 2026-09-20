import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { JevClient } from "@kelbie/hunch-core";
import { jobFromEvent, type ReviewJob } from "../lib/events.js";
import { runReview } from "../lib/review.js";
import { webhook } from "../api/webhook.js";

const BASE = "a".repeat(40), HEAD = "b".repeat(40), NEXT = "c".repeat(40);
const DIFF = "diff --git a/src/lib.ts b/src/lib.ts\n--- a/src/lib.ts\n+++ b/src/lib.ts\n@@ -1 +1,2 @@\n export const x = 1;\n+const recover = () => { try { pay(); } catch { return { ok: true }; } };\n";
const job: ReviewJob = { installationId: 1, repo: "o/r", pr: 7, headSha: HEAD, deliveryId: "delivery-1" };
const changes: { method: string; path: string; body: any }[] = [];
let currentHead: string, permission: string, failJev: boolean, moveDuringReview: boolean, duplicate: boolean, rejectLines: boolean, badConfig: boolean, flaky: Record<string, number>, rateLimit = false, diff = DIFF, failFile = "";
let threads: { id: string; line: number; isResolved: boolean; resolvedBy: { login: string } | null; comments: { nodes: { body: string; url: string; viewerDidAuthor: boolean }[] } }[];
const KEY = `failure ${encodeURIComponent("src/lib.ts")}`;
const thread = (id: string, key: string, over: Partial<(typeof threads)[number]> = {}, mine = true) =>
  ({ id, line: 2, isResolved: false, resolvedBy: null, comments: { nodes: [{ body: `<!-- hunch:finding ${key} -->\nconcern`, url: `https://github.com/o/r/pull/7#discussion_${id}`, viewerDidAuthor: mine }] }, ...over });
let server: ReturnType<typeof Bun.serve>;
const jev: JevClient = { async evaluate(req) {
  if (failJev || (failFile && req.state.file === failFile)) throw new Error("secret-provider-response");
  if (moveDuringReview) currentHead = NEXT;
  return { answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { type: "noul" as const, p: 0.95 }])), usage: { inputTokens: 10 }, modelId: "fake" };
} };
const deps = () => ({ token: "test", appId: 123, apiBase: `http://localhost:${server.port}`, jev: () => jev, sleep: async () => {} });
const pull = () => ({ number: 7, draft: false, state: "open", title: "Fix recovery", body: "", changed_files: 1, base: { sha: BASE }, head: { sha: currentHead } });
beforeEach(() => { currentHead = HEAD; permission = "write"; failJev = false; moveDuringReview = false; duplicate = false; rejectLines = false; badConfig = false; flaky = {}; rateLimit = false; diff = DIFF; failFile = ""; threads = []; changes.length = 0; });
beforeAll(() => {
  server = Bun.serve({ port: 0, async fetch(req) {
    const url = new URL(req.url), path = url.pathname;
    const body = req.method === "GET" ? undefined : await req.json();
    changes.push({ method: req.method, path, body });
    const key = `${req.method} ${path}`;
    if (flaky[key]) { flaky[key]--; return key.endsWith("/reviews") && rateLimit ? new Response("Slow down", { status: 403, headers: { "retry-after": "1" } }) : new Response("Bad gateway", { status: 502 }); }
    if (path.endsWith("/permission")) return Response.json({ permission: path.includes("/outsider/") ? "read" : permission });
    if (path === "/graphql") {
      if (body.query.includes("resolveReviewThread")) return Response.json({ data: { resolveReviewThread: { thread: { id: body.variables.id } } } });
      return Response.json({ data: { viewer: { login: "hunch[bot]" }, repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: threads } } } } });
    }
    if (path.endsWith("/pulls/7/reviews")) {
      if (rejectLines) return new Response("Unprocessable", { status: 422 });
      threads.push(...body.comments.map((c: { body: string }, i: number) => ({ ...thread(`new${i}`, ""), comments: { nodes: [{ body: c.body, url: `https://github.com/o/r/pull/7#discussion_new${i}`, viewerDidAuthor: true }] } })));
      return Response.json({ id: 1 });
    }
    if (path.endsWith("/pulls/7/comments")) return new Response("Unprocessable", { status: 422 });
    if (path.endsWith("/pulls/7")) return Response.json(pull());
    if (path.endsWith(`/git/trees/${BASE}`)) return Response.json({ tree: [{ path: "hunch.toml", type: "blob", mode: "100644" }] });
    if (path.endsWith(`/git/trees/${HEAD}`)) return Response.json({ tree: [{ path: "src/lib.ts", type: "blob", mode: "100644" }] });
    if (path.endsWith("/contents/src/lib.ts")) {
      expect(url.searchParams.get("ref")).toBe(HEAD);
      return new Response("export const x = 1;\nconst recover = () => { try { pay(); } catch { return { ok: true }; } };\n");
    }
    if (path.endsWith("/contents/hunch.toml")) {
      expect(url.searchParams.get("ref")).toBe(BASE);
      return new Response(badConfig ? "[rules\nbroken" : '[rules]\n"failure" = ["error", "A failed payment must not return success."]');
    }
    if (path.includes("/compare/")) { expect(path).toEndWith(`${BASE}...${HEAD}`); return new Response(diff); }
    if (path.includes(`/commits/${HEAD}/check-runs`)) return Response.json({ check_runs: duplicate ? [{ id: 99, app: { id: 123 }, external_id: `hunch:7:${BASE}:${HEAD}:delivery-1` }] : [] });
    if (path.endsWith("/check-runs") && req.method === "POST") return Response.json({ id: 99 });
    if (path.endsWith("/check-runs/99")) return Response.json({});
    if (path.endsWith("/issues/7/comments") && req.method === "GET") return Response.json(duplicate ? [{ id: 10, body: `<!-- hunch:summary -->\n<!-- head:${HEAD} -->`, performed_via_github_app: { id: 123 } }] : [{ id: 11, body: `<!-- hunch:summary -->\n<!-- head:${HEAD} -->`, performed_via_github_app: { id: 999 } }]);
    if (path.endsWith("/issues/7/comments") || path.endsWith("/issues/comments/10")) return Response.json({ id: 10 });
    return new Response("Unexpected request", { status: 500 });
  } });
});
afterAll(() => server.stop());

describe("GitHub review", () => {
  test("routes valid events and ignores malformed/draft events", () => {
    const envelope = { installation: { id: 1 }, repository: { full_name: "o/r" }, action: "opened" };
    expect(jobFromEvent("pull_request", { ...envelope, pull_request: pull() })).toMatchObject({ headSha: HEAD });
    expect(jobFromEvent("pull_request", { ...envelope, pull_request: { ...pull(), draft: true } })).toBeNull();
    expect(jobFromEvent("pull_request", envelope)).toBeNull();
    expect(jobFromEvent("pull_request", null)).toBeNull();
  });
  test("uses base policy and immutable diff, reports findings on exact head", async () => {
    expect(await runReview(job, deps())).toBe("done");
    const done = changes.find((c) => c.body?.conclusion === "neutral");
    expect(done?.body.output.annotations[0].title).toBe("failure");
    expect(changes.find((c) => c.method === "POST" && c.path.endsWith("/comments"))?.body.body).toContain(HEAD);
    expect(changes.some((c) => c.path.endsWith("/comments/11"))).toBe(false);
  });
  test("findings become native inline comments that the summary links to", async () => {
    await runReview(job, deps());
    const review = changes.find((c) => c.path.endsWith("/pulls/7/reviews"))!.body;
    expect(review).toMatchObject({ commit_id: HEAD, event: "COMMENT" });
    expect(review.comments).toEqual([expect.objectContaining({ path: "src/lib.ts", line: 2, side: "RIGHT" })]);
    expect(review.comments[0].body).toContain(`<!-- hunch:finding ${KEY} -->`);
    expect(review.comments[0].body).toContain("Resolve this conversation");
    const summary = changes.find((c) => c.method === "POST" && c.path.endsWith("/issues/7/comments"))!.body.body;
    expect(summary).toContain("](https://github.com/o/r/pull/7#discussion_new0)");
  });
  test("a thread resolved by a writer dismisses the concern; the review stays quiet and passes", async () => {
    threads = [thread("T1", KEY, { isResolved: true, resolvedBy: { login: "maintainer" } })];
    await runReview(job, deps());
    expect(changes.some((c) => c.path.endsWith("/reviews"))).toBe(false);
    expect(changes.find((c) => c.body?.conclusion)?.body.conclusion).toBe("success");
    expect(changes.find((c) => c.path.endsWith("/issues/7/comments") && c.method === "POST")!.body.body).toContain("1 dismissed");
  });
  test("dismissals by people without write access, or in threads Hunch didn't write, don't count", async () => {
    threads = [thread("T1", KEY, { isResolved: true, resolvedBy: { login: "outsider" } })];
    await runReview(job, deps());
    expect(changes.some((c) => c.path.endsWith("/reviews"))).toBe(false);
    expect(changes.find((c) => c.body?.conclusion)?.body.conclusion).toBe("neutral");
    threads = [thread("T2", KEY, { isResolved: true, resolvedBy: { login: "maintainer" } }, false)];
    changes.length = 0;
    await runReview(job, deps());
    expect(changes.find((c) => c.path.endsWith("/reviews"))?.body.comments).toHaveLength(1);
  });
  test("open threads for concerns no longer raised are resolved as fixed", async () => {
    threads = [thread("OLD", `other ${encodeURIComponent("src/lib.ts")}`), thread("T1", KEY)];
    await runReview(job, deps());
    const resolved = changes.filter((c) => c.body?.query?.includes("resolveReviewThread")).map((c) => c.body.variables.id);
    expect(resolved).toEqual(["OLD"]);
    expect(changes.some((c) => c.path.endsWith("/reviews"))).toBe(false);
    expect(changes.find((c) => c.path.endsWith("/issues/7/comments") && c.method === "POST")!.body.body).toContain("1 resolved as fixed");
  });
  test("locations GitHub rejects still appear in the summary with a code link", async () => {
    rejectLines = true;
    expect(await runReview(job, deps())).toBe("done");
    expect(changes.find((c) => c.path.endsWith("/issues/7/comments") && c.method === "POST")!.body.body).toContain(`/blob/${HEAD}/src/lib.ts#L2`);
  });
  test("retries reuse their own check and commit report", async () => {
    duplicate = true;
    threads = [thread("T1", KEY)]; // the earlier attempt already posted its comment
    await runReview(job, deps());
    expect(changes.some((c) => c.method === "POST" && c.path !== "/graphql")).toBe(false);
    expect(changes.some((c) => c.method === "PATCH" && c.path.endsWith("/comments/10"))).toBe(true);
  });
  test("old delivery skips without paid work", async () => {
    currentHead = NEXT;
    expect(await runReview(job, deps())).toBe("skipped");
    expect(changes).toHaveLength(1);
  });
  test("new commits during evaluation cancel the old check without publishing", async () => {
    moveDuringReview = true;
    expect(await runReview(job, deps())).toBe("skipped");
    expect(changes.some((c) => c.body?.conclusion === "cancelled")).toBe(true);
    expect(changes.some((c) => c.path.includes("/comments"))).toBe(false);
  });
  test("read-only collaborators cannot request paid reviews", async () => {
    permission = "read";
    expect(await runReview({ ...job, sender: "reader" }, deps())).toBe("skipped");
    expect(changes).toHaveLength(1);
  });
  test("provider errors say 'retrying' while the queue retries, and redact provider bodies", async () => {
    failJev = true;
    await expect(runReview(job, { ...deps(), attempt: 1, maxAttempts: 5 })).rejects.toThrow("safe to retry");
    const updates = changes.filter((c) => c.path.endsWith("/check-runs/99")).map((c) => c.body);
    expect(updates.at(-1)).toMatchObject({ status: "in_progress", output: { title: "Retrying after a temporary problem" } });
    expect(updates.some((u) => u.conclusion === "failure")).toBe(false);
    expect(JSON.stringify(changes)).not.toContain("secret-provider-response");
  });
  test("the last attempt fails the check and stops retrying", async () => {
    failJev = true;
    expect(await runReview(job, { ...deps(), attempt: 5, maxAttempts: 5 })).toBe("failed");
    const failed = changes.find((c) => c.body?.conclusion === "failure")!.body;
    expect(failed.output.summary).toContain("after 5 attempts");
    expect(JSON.stringify(changes)).not.toContain("secret-provider-response");
  });
  test("a provider failure part-way is retried by the queue, and the last attempt publishes the partial review", async () => {
    const other = "diff --git a/src/other.ts b/src/other.ts\n--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1 +1,2 @@\n export const y = 1;\n+export const z = 2;\n";
    diff = DIFF + other;
    failFile = "src/other.ts";
    await expect(runReview(job, { ...deps(), attempt: 1, maxAttempts: 5 })).rejects.toThrow("safe to retry");
    expect(changes.some((c) => c.path.endsWith("/issues/7/comments"))).toBe(false);

    changes.length = 0;
    expect(await runReview(job, { ...deps(), attempt: 5, maxAttempts: 5 })).toBe("done");
    const summary = changes.find((c) => c.path.endsWith("/issues/7/comments") && c.method === "POST")!.body.body as string;
    expect(summary).toContain("partial review");
    expect(summary).toContain("src/other.ts:1: 1 rule went unanswered");
    // The concern in the file that was answered is still raised.
    expect(summary).toContain("lib.ts");
    expect(JSON.stringify(changes)).not.toContain("secret-provider-response");
  });
  test("an invalid base config fails at once with a fix, without retrying", async () => {
    badConfig = true;
    expect(await runReview(job, { ...deps(), attempt: 1, maxAttempts: 5 })).toBe("failed");
    expect(changes.find((c) => c.body?.conclusion === "failure")!.body.output.summary).toContain("config on the base branch is invalid");
  });
  test("an installation over its daily budget is told so and spends nothing on the model", async () => {
    let evaluated = false;
    const counting: JevClient = { async evaluate(req) { evaluated = true; return jev.evaluate(req); } };
    expect(await runReview(job, { ...deps(), jev: () => counting, attempt: 1, maxAttempts: 5, quota: async () => ({ allowed: false, limit: 25 }) })).toBe("failed");
    const summary = changes.find((c) => c.body?.conclusion === "failure")!.body.output.summary;
    expect(summary).toContain("25 Hunch reviews for today");
    expect(evaluated).toBe(false);
  });
  test("a review within budget is charged once, for this head commit", async () => {
    const charged: string[] = [];
    expect(await runReview(job, { ...deps(), quota: async (unit) => { charged.push(unit); return { allowed: true, limit: 25 }; } })).toBe("done");
    expect(charged).toEqual([`o/r:7:${HEAD}`]);
  });
  test("GitHub server errors are retried for reads, but a write that may have landed is not resent", async () => {
    flaky = { [`GET /repos/o/r/pulls/7`]: 2, "POST /graphql": 1 };
    expect(await runReview(job, deps())).toBe("done");
    expect(changes.filter((c) => c.method === "GET" && c.path === "/repos/o/r/pulls/7").length).toBeGreaterThanOrEqual(3);
    changes.length = 0;
    flaky = { "POST /repos/o/r/pulls/7/reviews": 1 };
    threads = [];
    await expect(runReview(job, { ...deps(), attempt: 1, maxAttempts: 5 })).rejects.toThrow("safe to retry");
    expect(changes.filter((c) => c.path.endsWith("/pulls/7/reviews"))).toHaveLength(1);
  });
  test("a rate-limited write was never applied, so it is resent", async () => {
    rateLimit = true;
    flaky = { "POST /repos/o/r/pulls/7/reviews": 1 };
    expect(await runReview(job, deps())).toBe("done");
    expect(changes.filter((c) => c.path.endsWith("/pulls/7/reviews"))).toHaveLength(2);
  });
});

describe("webhook acceptance", () => {
  function request(body = JSON.stringify({ installation: { id: 1 }, repository: { full_name: "o/r" }, action: "opened", pull_request: pull() }), signature?: string) {
    return new Request("https://hunch.test/api/webhook", { method: "POST", body, headers: { "x-github-event": "pull_request", "x-github-delivery": "delivery-1", "x-hub-signature-256": signature ?? `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}` } });
  }
  test("valid signature enqueues before acknowledgement", async () => {
    let received: ReviewJob | undefined;
    const res = await webhook(request(), { secret: "test-secret", enqueue: async (job) => { received = job; } });
    expect(res.status).toBe(202);
    expect(received?.deliveryId).toBe("delivery-1");
  });
  test("bad signature and malformed JSON never enqueue", async () => {
    const deps = { secret: "test-secret", enqueue: async () => { throw new Error("must not enqueue"); } };
    expect((await webhook(request("{}", "bad"), deps)).status).toBe(401);
    expect((await webhook(request("{"), deps)).status).toBe(400);
  });
  test("queue failure does not acknowledge success", async () => {
    expect((await webhook(request(), { secret: "test-secret", enqueue: async () => { throw new Error("down"); } })).status).toBe(503);
  });
});
