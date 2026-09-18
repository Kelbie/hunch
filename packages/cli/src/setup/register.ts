import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { APP_EVENTS, APP_PERMISSIONS, appJwt, saveCredentials, webhookUrl, type Request } from "./app.js";

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const registrationSchema = z.object({ id: z.number().int().positive(), slug: z.string().regex(/^[a-z0-9-]+$/), pem: z.string().min(1), webhook_secret: z.string().min(32) });

/** GitHub confirmation stays in the user's browser; secrets return only to loopback. */
export async function registerApp(options: {
  name: string; webhook: string; organization?: string;
  onReady: (url: string) => void;
  request?: Request;
  save?: typeof saveCredentials;
  signal?: AbortSignal;
}) {
  const webhook = webhookUrl(options.webhook);
  if (!options.name.trim() || options.name.length > 100) throw new Error("Choose an App name of 1–100 characters.");
  if (options.organization && !/^[a-zA-Z0-9-]+$/.test(options.organization)) throw new Error("Invalid GitHub organization.");
  const nonce = randomBytes(32).toString("hex");
  const lifetime = new AbortController();
  const action = options.organization ? `https://github.com/organizations/${options.organization}/settings/apps/new` : "https://github.com/settings/apps/new";
  let finish!: (value: { id: number; slug: string; installationUrl: string }) => void;
  let fail!: (error: Error) => void;
  const completed = new Promise<{ id: number; slug: string; installationUrl: string }>((resolve, reject) => { finish = resolve; fail = reject; });
  let active = false;
  let origin = "";
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; form-action https://github.com; frame-ancestors 'none'; base-uri 'none'");
    if (req.method !== "GET" || req.headers.host !== new URL(origin).host) { res.writeHead(403).end("Forbidden"); return; }
    const url = new URL(req.url ?? "/", origin);
    if (url.pathname === `/start/${nonce}`) {
      const manifest = { name: options.name, description: "Semantic PR review with Jev and Agent Skills.", url: "https://github.com/Kelbie/hunch", public: false,
        hook_attributes: { url: webhook, active: true }, redirect_url: `${origin}/callback`,
        default_permissions: APP_PERMISSIONS, default_events: APP_EVENTS, request_oauth_on_install: false };
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<h1>Register Hunch</h1><p>GitHub will ask you to confirm the App name and access. This creates a private App owned by you.</p><form method="post" action="${action}?state=${nonce}"><input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}"><button>Continue to GitHub</button></form>`);
      return;
    }
    if (url.pathname !== "/callback" || url.searchParams.get("state") !== nonce || !/^[a-zA-Z0-9_-]{10,200}$/.test(url.searchParams.get("code") ?? "")) { res.writeHead(403).end("Invalid callback"); return; }
    if (active) { res.writeHead(409).end("Registration already processing"); return; }
    active = true;
    try {
      const response = await (options.request ?? fetch)(`https://api.github.com/app-manifests/${url.searchParams.get("code")}/conversions`, {
        method: "POST", redirect: "error", signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]),
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      });
      if (!response.ok) throw new Error("Manifest conversion failed");
      const parsed = registrationSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("Invalid registration response");
      const { id, slug, pem, webhook_secret } = parsed.data;
      lifetime.signal.throwIfAborted();
      appJwt(id, pem); // Validate GitHub supplied a usable RSA key before saving.
      (options.save ?? saveCredentials)({ id, slug, privateKey: pem, webhookSecret: webhook_secret, webhookUrl: webhook });
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("App credentials saved privately. Return to your terminal for the installation and deployment steps.", () => {
        finish({ id, slug, installationUrl: `https://github.com/apps/${slug}/installations/new` });
      });
    } catch {
      res.writeHead(502).end("Registration could not finish. Return to your terminal. No credentials were displayed.", () => {
        fail(new Error("GitHub registration or private credential save failed. If GitHub created the App, recover its private key through App settings; do not blindly register another App."));
      });
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("Could not open loopback callback"); }
  origin = `http://127.0.0.1:${address.port}`;
  const timeout = setTimeout(() => fail(new Error("App registration timed out after 10 minutes.")), 600_000);
  const abort = () => fail(new Error("App registration cancelled."));
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal?.aborted) abort();
    else options.onReady(`${origin}/start/${nonce}`);
    return await completed;
  } finally {
    lifetime.abort();
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    server.close();
    server.closeAllConnections();
  }
}
