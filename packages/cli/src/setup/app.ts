import { createPrivateKey, createSign, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";

export const APP_PERMISSIONS = { contents: "read", issues: "read", metadata: "read", pull_requests: "write", checks: "write" } as const;
export const APP_EVENTS = ["pull_request", "issue_comment"];
const credentialsSchema = z.object({
  id: z.number().int().positive(), slug: z.string().regex(/^[a-z0-9-]+$/),
  privateKey: z.string().min(1), webhookSecret: z.string().min(32), webhookUrl: z.string().url(),
});
export type AppCredentials = z.infer<typeof credentialsSchema>;
export type Request = (url: string, init: RequestInit) => Promise<Response>;
export type SecretSink = (name: string, value: string) => void;

export function webhookUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/api/webhook") {
    throw new Error("Use an HTTPS deployment URL ending in /api/webhook, without credentials or query parameters.");
  }
  return url.href;
}

export function appJwt(id: number, privateKey: string): string {
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== "rsa") throw new Error("GitHub requires an RSA private key.");
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: String(id) })}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(key, "base64url")}`;
}

export async function github(path: string, token: string, request: Request = fetch, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await request(`https://api.github.com${path}`, {
      method: body ? "PATCH" : "GET", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw new Error("GitHub setup request failed; no credentials were logged."); }
  if (!response.ok) throw new Error(`GitHub setup request failed (HTTP ${response.status}). Check App ID, key and access.`);
  try { return await response.json(); } catch { throw new Error("GitHub returned an invalid setup response."); }
}

const appSchema = z.object({
  id: z.number().int().positive(), slug: z.string().regex(/^[a-z0-9-]+$/),
  owner: z.object({ login: z.string().regex(/^[a-zA-Z0-9-]+$/), type: z.enum(["User", "Organization"]) }),
  permissions: z.record(z.string(), z.string()), events: z.array(z.string()),
});
export async function inspectApp(id: number, privateKey: string, request: Request = fetch) {
  const parsed = appSchema.safeParse(await github("/app", appJwt(id, privateKey), request));
  if (!parsed.success || parsed.data.id !== id) throw new Error("GitHub returned unexpected App metadata.");
  const app = parsed.data;
  const missingPermissions = Object.entries(APP_PERMISSIONS).filter(([name, level]) => app.permissions[name] !== "write" && app.permissions[name] !== level).map(([name]) => name);
  if (missingPermissions.length) throw new Error(`App needs these permissions: ${missingPermissions.join(", ")}. Update its GitHub settings first.`);
  const settingsRoot = app.owner.type === "Organization" ? `https://github.com/organizations/${app.owner.login}/settings/apps` : "https://github.com/settings/apps";
  return { id: app.id, slug: app.slug, missingEvents: APP_EVENTS.filter(event => !app.events.includes(event)), settingsUrl: `${settingsRoot}/${app.slug}/permissions` };
}

function credentialsPath(id: number): string {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("App ID must be a positive integer.");
  return join(homedir(), ".config", "hunch", "apps", `${id}.json`);
}
export function readCredentials(id: number): AppCredentials | null {
  const path = credentialsPath(id);
  if (!existsSync(path)) return null;
  if (!lstatSync(path).isFile() || (process.platform !== "win32" && (lstatSync(path).mode & 0o077))) throw new Error("App credential file must be a private regular file (chmod 600).");
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("Invalid saved App credentials."); }
  const parsed = credentialsSchema.safeParse(value);
  if (!parsed.success || parsed.data.id !== id) throw new Error("Invalid saved App credentials.");
  return parsed.data;
}
export function saveCredentials(credentials: AppCredentials): string {
  const path = credentialsPath(credentials.id);
  mkdirSync(join(homedir(), ".config", "hunch", "apps"), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(credentials)}\n`, { flag: "wx", mode: 0o600 });
  return path;
}

/** Credentials go only over stdin to a pinned official Vercel CLI, never in argv. */
export function vercelSecrets(project: string, scope: string): SecretSink {
  for (const value of [project, scope]) if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Invalid Vercel project or scope.");
  return (name, value) => {
    const result = spawnSync("npx", ["--yes", "vercel@59.23.0", "env", "add", name, "production", "--project", project, "--scope", scope, "--sensitive", "--force", "--yes"], {
      input: value, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 120_000,
    });
    // Never echo subprocess output: failures can include request details or stdin.
    if (result.error || result.status !== 0) throw new Error(`Could not set ${name} on Vercel. Check CLI login and project access, then rerun; credentials remain saved locally.`);
  };
}

/** Persist before external changes so a interrupted setup can resume with the same secret. */
export async function connectApp(options: {
  id: number; privateKey?: string; webhook: string;
  load?: (id: number) => AppCredentials | null;
  save?: (credentials: AppCredentials) => string;
  setSecret: SecretSink; request?: Request;
}) {
  const url = webhookUrl(options.webhook);
  const saved = (options.load ?? readCredentials)(options.id);
  const privateKey = saved?.privateKey ?? options.privateKey;
  if (!privateKey) throw new Error("First connection needs --private-key /path/to/app.pem; subsequent runs use saved credentials.");
  const app = await inspectApp(options.id, privateKey, options.request);
  if (saved && (saved.slug !== app.slug || saved.webhookUrl !== url || options.privateKey && options.privateKey !== saved.privateKey)) throw new Error("Saved App identity, key or webhook differs. Use the saved deployment and key; migration requires explicit operator handling.");
  const credentials = saved ?? { id: app.id, slug: app.slug, privateKey, webhookSecret: randomBytes(32).toString("hex"), webhookUrl: url };
  if (!saved) (options.save ?? saveCredentials)(credentials);
  options.setSecret("GITHUB_APP_ID", String(app.id));
  options.setSecret("GITHUB_PRIVATE_KEY", credentials.privateKey);
  options.setSecret("GITHUB_WEBHOOK_SECRET", credentials.webhookSecret);
  await github("/app/hook/config", appJwt(app.id, privateKey), options.request, { url, content_type: "json", insecure_ssl: "0", secret: credentials.webhookSecret });
  return { ...app, installationUrl: `https://github.com/apps/${app.slug}/installations/new` };
}
