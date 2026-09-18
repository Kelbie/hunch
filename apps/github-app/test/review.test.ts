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
let currentHead: string, permission: string, failJev: boolean, moveDuringReview: boolean, duplicate: boolean;
let server: ReturnType<typeof Bun.serve>;
const jev: JevClient = { async evaluate(req) {
  if (failJev) throw new Error("secret-provider-response");
  if (moveDuringReview) currentHead = NEXT;
  return { answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { type: "noul" as const, p: 0.95 }])), usage: { inputTokens: 10 }, modelId: "fake" };
} };
const deps = () => ({ token: "test", appId: 123, apiBase: `http://localhost:${server.port}`, jev: () => jev });
const pull = () => ({ number: 7, draft: false, state: "open", title: "Fix recovery", body: "", changed_files: 1, base: { sha: BASE }, head: { sha: currentHead } });
beforeEach(() => { currentHead = HEAD; permission = "write"; failJev = false; moveDuringReview = false; duplicate = false; changes.length = 0; });
beforeAll(() => {
  server = Bun.serve({ port: 0, async fetch(req) {
    const url = new URL(req.url), path = url.pathname;
    const body = req.method === "GET" ? undefined : await req.json();
    changes.push({ method: req.method, path, body });
    if (path.endsWith("/permission")) return Response.json({ permission });
    if (path.endsWith("/pulls/7")) return Response.json(pull());
    if (path.endsWith(`/git/trees/${BASE}`)) return Response.json({ tree: [{ path: "hunch.toml", type: "blob", mode: "100644" }] });
    if (path.endsWith("/contents/hunch.toml")) {
      expect(url.searchParams.get("ref")).toBe(BASE);
      return new Response('[rules]\n"failure" = ["error", "A failed payment must not return success."]');
    }
    if (path.includes("/compare/")) { expect(path).toEndWith(`${BASE}...${HEAD}`); return new Response(DIFF); }
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
  test("retries reuse their own check and commit report", async () => {
    duplicate = true;
    await runReview(job, deps());
    expect(changes.some((c) => c.method === "POST")).toBe(false);
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
  test("provider errors fail visibly, remain retryable and redact provider bodies", async () => {
    failJev = true;
    await expect(runReview(job, deps())).rejects.toThrow("safe to retry");
    expect(changes.some((c) => c.body?.conclusion === "failure")).toBe(true);
    expect(JSON.stringify(changes)).not.toContain("secret-provider-response");
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
