import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { connect } from "node:net";
import { connectApp, type AppCredentials, type Request } from "../src/setup/app.js";
import { registerApp } from "../src/setup/register.js";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const metadata = { id: 42, slug: "hunch-test", owner: { login: "acme", type: "Organization" }, permissions: { contents: "read", issues: "read", metadata: "read", pull_requests: "write", checks: "write" }, events: ["pull_request", "issue_comment"] };
const webhook = "https://example.vercel.app/api/webhook";

test("App connection resumes a failed secret upload without losing or rotating its saved secret", async () => {
  let saved: AppCredentials | null = null;
  let patches = 0;
  const uploaded = new Map<string, string>();
  const request: Request = async (url, init) => {
    if (url.endsWith("/app")) return Response.json(metadata);
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(String(init.body));
    expect(body.secret).toBe(uploaded.get("GITHUB_WEBHOOK_SECRET"));
    expect(body.url).toBe(webhook);
    patches++;
    return Response.json({});
  };
  const options = { id: 42, privateKey, webhook, request, load: () => saved, save: (value: AppCredentials) => { saved = value; return "private-store"; } };
  await expect(connectApp({ ...options, setSecret: () => { expect(saved).not.toBeNull(); throw new Error("upload unavailable"); } })).rejects.toThrow("upload unavailable");
  expect(patches).toBe(0);
  const original = saved;
  const result = await connectApp({ ...options, setSecret: (name, value) => { uploaded.set(name, value); } });
  expect(saved).toBe(original);
  expect(patches).toBe(1);
  expect(uploaded.get("GITHUB_PRIVATE_KEY")).toBe(privateKey);
  expect(result).toEqual({ id: 42, slug: "hunch-test", missingEvents: [], settingsUrl: "https://github.com/organizations/acme/settings/apps/hunch-test/permissions", installationUrl: "https://github.com/apps/hunch-test/installations/new" });
  expect(JSON.stringify(result)).not.toContain(privateKey);
  await expect(connectApp({ ...options, webhook: "https://another.vercel.app/api/webhook", setSecret: () => { throw new Error("must not upload"); } })).rejects.toThrow("differs");
});

test("App setup fails closed on missing permissions and never exposes provider response bodies", async () => {
  const options = { id: 42, privateKey, webhook, load: () => null, save: () => { throw new Error("must not save"); }, setSecret: () => { throw new Error("must not upload"); } };
  await expect(connectApp({ ...options, request: async () => Response.json({ ...metadata, permissions: { contents: "read" } }) })).rejects.toThrow("App needs these permissions");
  await expect(connectApp({ ...options, request: async () => new Response("secret provider body", { status: 401 }) })).rejects.toThrow("GitHub setup request failed (HTTP 401)");
});

test("registration uses a loopback manifest flow and rejects forged callbacks before exchanging credentials", async () => {
  let ready!: (url: string) => void;
  const started = new Promise<string>(resolve => { ready = resolve; });
  let exchanges = 0;
  let saved: AppCredentials | undefined;
  const done = registerApp({ name: "Hunch test", webhook, onReady: ready,
    save: value => { saved = value; return "private-store"; },
    request: async (url, init) => {
      exchanges++;
      expect(url).toBe("https://api.github.com/app-manifests/test-manifest-code/conversions");
      expect(init.method).toBe("POST");
      return Response.json({ id: 42, slug: "hunch-test", pem: privateKey, webhook_secret: "a".repeat(40), client_secret: "discard-this" });
    } });
  const start = new URL(await started);
  expect(start.hostname).toBe("127.0.0.1");
  const malformedStatus = await new Promise<number>((resolve, reject) => {
    const socket = connect(Number(start.port), start.hostname, () => {
      socket.write(`GET //[ HTTP/1.1\r\nHost: ${start.host}\r\nConnection: close\r\n\r\n`);
    });
    let response = "";
    socket.on("data", data => { response += data.toString(); });
    socket.on("end", () => resolve(Number(response.match(/^HTTP\/1\.1 (\d+)/)?.[1])));
    socket.on("error", reject);
  });
  expect(malformedStatus).toBe(400);
  const page = await fetch(start);
  expect(page.headers.get("cache-control")).toBe("no-store");
  const html = await page.text();
  expect(html).toContain("https://github.com/settings/apps/new?state=");
  expect(html).toContain("issue_comment");
  // Private unless asked for: a public App can be installed, and billed, by accounts you don't control.
  expect(html).toContain("&quot;public&quot;:false");
  expect(html).toContain("private");
  const forged = await fetch(`${start.origin}/callback?state=forged&code=test-manifest-code`);
  expect(forged.status).toBe(403);
  expect(exchanges).toBe(0);
  const nonce = start.pathname.split("/").at(-1)!;
  const callback = await fetch(`${start.origin}/callback?state=${nonce}&code=test-manifest-code`);
  expect(callback.status).toBe(200);
  expect(await callback.text()).not.toContain(privateKey);
  expect(await done).toMatchObject({ id: 42, slug: "hunch-test" });
  expect(saved?.privateKey).toBe(privateKey);
  expect(JSON.stringify(saved)).not.toContain("discard-this");
  expect(exchanges).toBe(1);
});

test("registering a public App says so before GitHub is asked, and stays private by default", async () => {
  const page = async (opts: { public?: boolean }) => {
    let ready!: (url: string) => void;
    const started = new Promise<string>((resolve) => { ready = resolve; });
    const controller = new AbortController();
    const done = registerApp({ name: "Hunch test", webhook, onReady: ready, signal: controller.signal, save: () => "private-store", ...opts });
    const html = await (await fetch(new URL(await started))).text();
    controller.abort();
    await done.catch(() => {});
    return html;
  };
  const open = await page({ public: true });
  expect(open).toContain("&quot;public&quot;:true");
  expect(open).toContain("other accounts can install it");
  expect(open).toContain("billed to your provider account");
  expect(await page({})).toContain("&quot;public&quot;:false");
});
