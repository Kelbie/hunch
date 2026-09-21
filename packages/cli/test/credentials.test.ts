import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCredentials, authHint, nextStep, credentialsPath, keySources, linkedVercelProject, looselyPermitted, mintVercelToken, readCredentials, readVercelLink, removeCredentials, removeVercelLink, saveCredential, saveVercelLink, useVercelLink } from "../src/credentials.js";

const dir = (prefix = "hunch-cred-") => mkdtempSync(join(tmpdir(), prefix));
const BIN = join(import.meta.dir, "../src/bin.ts");

/** The CLI as a person runs it: its own config directory, no inherited keys, a directory with no `.env`. */
function hunch(args: string[], opts: { config: string; cwd?: string; input?: string; env?: Record<string, string> }) {
  const { AI_GATEWAY_API_KEY: _a, TYPESAFE_API_KEY: _t, VERCEL_OIDC_TOKEN: _o, ...env } = process.env;
  return spawnSync("bun", [BIN, ...args], { cwd: opts.cwd ?? dir("hunch-cwd-"), input: opts.input ?? "", encoding: "utf8", env: { ...env, HUNCH_CONFIG_DIR: opts.config, ...opts.env } });
}

test("the store lives in the user's config directory, not the project", () => {
  expect(credentialsPath({}, "/home/a", "linux")).toBe("/home/a/.config/hunch/credentials");
  expect(credentialsPath({ XDG_CONFIG_HOME: "/x" }, "/home/a", "linux")).toBe("/x/hunch/credentials");
  expect(credentialsPath({ APPDATA: "/roaming" }, "/home/a", "win32")).toBe("/roaming/hunch/credentials");
  expect(credentialsPath({ HUNCH_CONFIG_DIR: "/elsewhere", XDG_CONFIG_HOME: "/x" }, "/home/a", "linux")).toBe("/elsewhere/credentials");
});

test("a stored key is owner-only, replaces its predecessor and leaves the other provider's key alone", () => {
  const path = join(dir(), "nested", "credentials");
  saveCredential("AI_GATEWAY_API_KEY", "  first\n", path);
  saveCredential("TYPESAFE_API_KEY", "ts-key", path);
  saveCredential("AI_GATEWAY_API_KEY", "second", path);
  expect(readCredentials(path)).toEqual({ AI_GATEWAY_API_KEY: "second", TYPESAFE_API_KEY: "ts-key" });
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(looselyPermitted(path)).toBe(false);
  chmodSync(path, 0o644);
  expect(looselyPermitted(path)).toBe(true);
  saveCredential("AI_GATEWAY_API_KEY", "third", path);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("something that is not a key is refused rather than stored", () => {
  const path = join(dir(), "credentials");
  expect(() => saveCredential("AI_GATEWAY_API_KEY", "   ", path)).toThrow("does not look like a key");
  expect(() => saveCredential("AI_GATEWAY_API_KEY", "two words", path)).toThrow("does not look like a key");
  expect(() => saveCredential("AI_GATEWAY_API_KEY", "a\nNODE_OPTIONS=--require=/tmp/x", path)).toThrow("does not look like a key");
  expect(existsSync(path)).toBe(false);
});

test("the environment and the project's .env win; a stored key only fills what they left unset", () => {
  const path = join(dir(), "credentials");
  saveCredential("AI_GATEWAY_API_KEY", "stored-gw", path);
  saveCredential("TYPESAFE_API_KEY", "stored-ts", path);
  const env: Record<string, string | undefined> = { AI_GATEWAY_API_KEY: "from-project" };
  const applied = applyCredentials(env, path);
  expect(applied).toEqual(["TYPESAFE_API_KEY"]);
  expect(env).toEqual({ AI_GATEWAY_API_KEY: "from-project", TYPESAFE_API_KEY: "stored-ts" });
  expect(keySources(env, applied)).toEqual({ AI_GATEWAY_API_KEY: "environment", TYPESAFE_API_KEY: "stored" });
  expect(keySources({}, [])).toEqual({ AI_GATEWAY_API_KEY: "missing", TYPESAFE_API_KEY: "missing" });
});

test("a tampered store cannot export anything but the two keys", () => {
  const path = join(dir(), "credentials");
  writeFileSync(path, 'NODE_OPTIONS=--require=/tmp/evil.js\nHTTPS_PROXY=http://evil\nexport PATH=/evil\nAI_GATEWAY_API_KEY="quoted"\nHUNCH_VERCEL_PROJECT=prj_1\n');
  const env: Record<string, string | undefined> = {};
  applyCredentials(env, path);
  expect(env).toEqual({ AI_GATEWAY_API_KEY: "quoted" });
});

test("logout removes what was asked, reports what was there, and deletes an emptied file", () => {
  const path = join(dir(), "credentials");
  saveCredential("AI_GATEWAY_API_KEY", "gw", path);
  saveCredential("TYPESAFE_API_KEY", "ts", path);
  saveVercelLink({ project: "prj_1", team: "team_1" }, path);
  expect(removeCredentials(["TYPESAFE_API_KEY"], path)).toEqual(["TYPESAFE_API_KEY"]);
  expect(readCredentials(path)).toEqual({ AI_GATEWAY_API_KEY: "gw" });
  expect(readVercelLink(path)).toEqual({ project: "prj_1", team: "team_1" });
  expect(removeCredentials(undefined, path)).toEqual(["AI_GATEWAY_API_KEY"]);
  expect(removeCredentials(undefined, path)).toEqual([]);
  expect(removeVercelLink(path)).toBe(true);
  expect(removeVercelLink(path)).toBe(false);
  expect(existsSync(path)).toBe(false);
});

test("a Vercel project is found the way the AI SDK finds it, and a changed team does not keep the old one", () => {
  const root = dir();
  mkdirSync(join(root, ".vercel"));
  mkdirSync(join(root, "packages/app"), { recursive: true });
  writeFileSync(join(root, ".vercel/project.json"), JSON.stringify({ projectId: "prj_abc", orgId: "team_abc" }));
  expect(linkedVercelProject(join(root, "packages/app"))).toEqual({ project: "prj_abc", team: "team_abc" });
  writeFileSync(join(root, ".vercel/project.json"), "{ not json");
  expect(linkedVercelProject(root)).toBeNull();

  const path = join(dir(), "credentials");
  saveVercelLink({ project: "one", team: "team-a" }, path);
  saveVercelLink({ project: "two" }, path);
  expect(readVercelLink(path)).toEqual({ project: "two" });
  expect(() => saveVercelLink({ project: "x y; rm" }, path)).toThrow("not a Vercel project");
});

test("the stored Vercel project signs in only when nothing nearer can", async () => {
  const path = join(dir(), "credentials");
  const unlinked = dir();
  const asked: unknown[] = [];
  const mint = async (link: unknown) => { asked.push(link); return "oidc-token"; };

  expect(await useVercelLink({ env: {}, cwd: unlinked, path, mint })).toBe(false); // nothing stored
  saveVercelLink({ project: "prj_1", team: "team_1" }, path);

  const withKey = { AI_GATEWAY_API_KEY: "key" };
  expect(await useVercelLink({ env: withKey, cwd: unlinked, path, mint })).toBe(false);
  const linked = dir();
  mkdirSync(join(linked, ".vercel"));
  writeFileSync(join(linked, ".vercel/project.json"), JSON.stringify({ projectId: "prj_local" }));
  expect(await useVercelLink({ env: {}, cwd: linked, path, mint })).toBe(false);
  expect(asked).toEqual([]);

  const env: Record<string, string | undefined> = {};
  expect(await useVercelLink({ env, cwd: unlinked, path, mint })).toBe(true);
  expect(asked).toEqual([{ project: "prj_1", team: "team_1" }]);
  expect(env.VERCEL_OIDC_TOKEN).toBe("oidc-token");
});

test("a Vercel failure is reported as one, without the helper's raw message", async () => {
  const failing = async () => { throw new Error("401 {\"error\":{\"token\":\"secret-body\"}}"); };
  const error = await mintVercelToken({ project: "prj_1" }, failing).catch((e: Error) => e);
  expect((error as Error).message).toContain("vercel login");
  expect((error as Error).message).not.toContain("secret-body");
  const path = join(dir(), "credentials");
  saveVercelLink({ project: "prj_1" }, path);
  await expect(useVercelLink({ env: {}, cwd: dir(), path, mint: failing })).rejects.toThrow("prj_1");
});

test("only authentication failures get the login hint, and it never repeats itself", () => {
  expect(authHint("AI Gateway authentication failed: No authentication provided.")).toContain("hunch auth login");
  expect(authHint("provider = typesafe needs TYPESAFE_API_KEY")).toContain("--with-token");
  expect(authHint("Jev request failed (HTTP 401). Check provider credentials, quota and availability.")).not.toBeNull();
  expect(authHint("Jev request failed (HTTP 429). Check provider credentials, quota and availability.")).toBeNull();
  expect(authHint("no hunch config found.")).toBeNull();
  expect(authHint("Vercel could not issue a token. Run `hunch auth login --vercel`.")).toBeNull();
});

test("login takes the key from standard input, status names its source without showing it, logout removes it", () => {
  const config = dir();
  const login = hunch(["auth", "login", "--provider", "typesafe", "--with-token"], { config, input: "ts-secret-value\n" });
  expect(login.status).toBe(0);
  expect(login.stdout + login.stderr).not.toContain("ts-secret-value");
  expect(readFileSync(join(config, "credentials"), "utf8")).toBe("TYPESAFE_API_KEY=ts-secret-value\n");

  const status = hunch(["auth", "status", "--reporter", "json"], { config });
  expect(status.status).toBe(0);
  expect(status.stdout).not.toContain("ts-secret-value");
  expect(JSON.parse(status.stdout)).toMatchObject({ keys: { AI_GATEWAY_API_KEY: "missing", TYPESAFE_API_KEY: "stored" }, vercelProject: null });

  const pinned = hunch(["auth", "status", "--reporter", "json"], { config, env: { TYPESAFE_API_KEY: "from-shell" } });
  expect(JSON.parse(pinned.stdout).keys.TYPESAFE_API_KEY).toBe("environment");

  expect(hunch(["auth", "logout"], { config }).status).toBe(0);
  const after = hunch(["auth", "status"], { config });
  expect(after.status).toBe(1);
  expect(after.stdout).toContain("hunch auth login");
}, 60_000);

test("login never stores a guess: no terminal, a bad provider, a key in the wrong shape and a missing link all fail with exit 2", () => {
  const config = dir();
  const noTerminal = hunch(["auth", "login"], { config });
  expect(noTerminal.status).toBe(2);
  expect(noTerminal.stderr).toContain("--with-token");
  expect(hunch(["auth", "login", "--provider", "openai", "--with-token"], { config, input: "k" }).status).toBe(2);
  expect(hunch(["auth", "login", "--with-token"], { config, input: "" }).status).toBe(2);
  expect(hunch(["auth", "login", "--project", "p"], { config }).status).toBe(2);
  const unlinked = hunch(["auth", "login", "--vercel"], { config });
  expect(unlinked.status).toBe(2);
  expect(unlinked.stderr).toContain("vercel link");
  expect(existsSync(join(config, "credentials"))).toBe(false);
}, 60_000);

test("a failure Hunch recognises names the command to run next, so an agent can recover from it", () => {
  const signIn = nextStep("AI Gateway authentication failed: No authentication provided.")!;
  expect(signIn).toContain("npx @kelbie/hunch auth login --provider typesafe");
  expect(signIn).toContain("must not ask for the key");
  const zdr = nextStep("Zero Data Retention (ZDR) is only available for Pro and Enterprise plans. Current plan: hobby.")!;
  expect(zdr).toContain("npx @kelbie/hunch auth login --provider typesafe");
  expect(zdr).toContain(`--config '{"zeroDataRetention":false}'`);
  expect(zdr).toContain("do not make it for them");
  expect(nextStep("Command failed: git ls-files\nfatal: not a git repository (or any of the parent directories): .git")).toContain("--cwd <dir>");
  expect(nextStep("Jev request failed (HTTP 402). Check provider credentials, quota and availability.")).toContain("no credit or quota left");
  // A rate limit is not something a command fixes, so nothing is invented for it.
  expect(nextStep("Jev request failed (HTTP 429).")).toBeNull();
});
