import { expect, test } from "bun:test";
import { diagnose, parseRemote, report, type Check, type DoctorIo } from "../src/doctor.js";

const APP = "hunch-review";

/** A GitHub whose answers are declared per path; anything unlisted is a 404, as gh would report. */
function githubIo(opts: {
  remote?: string | null;
  local?: Record<string, string>;
  api?: Record<string, unknown>;
}): DoctorIo {
  return {
    async gh(args) {
      const path = args[1]!;
      const body = opts.api?.[path];
      return body === undefined ? { ok: false, body: "" } : { ok: true, body: JSON.stringify(body) };
    },
    local: (p) => opts.local?.[p] ?? null,
    remoteUrl: () => (opts.remote === undefined ? "git@github.com:SovranBitcoin/Sovran.git" : opts.remote),
    env: {},
  };
}

const find = (checks: Check[], label: string) => checks.find((c) => c.label.startsWith(label))!;

test("both spellings of a GitHub remote are understood, and other hosts are not claimed", () => {
  expect(parseRemote("git@github.com:SovranBitcoin/Sovran.git")).toEqual({ owner: "SovranBitcoin", repo: "Sovran" });
  expect(parseRemote("https://github.com/Kelbie/hunch.git")).toEqual({ owner: "Kelbie", repo: "hunch" });
  expect(parseRemote("https://github.com/Kelbie/hunch")).toEqual({ owner: "Kelbie", repo: "hunch" });
  expect(parseRemote("ssh://git@github.com/o/r.git")).toEqual({ owner: "o", repo: "r" });
  expect(parseRemote("git@gitlab.com:o/r.git")).toBeNull();
  expect(parseRemote(null)).toBeNull();
});

test("the real SovranBitcoin case: config is on main, but a private App cannot reach another owner", async () => {
  const checks = await diagnose(githubIo({
    local: { "hunch.config.ts": "export default {}" },
    api: {
      "/repos/SovranBitcoin/Sovran": { default_branch: "main", owner: { type: "Organization", login: "SovranBitcoin" } },
      "/repos/SovranBitcoin/Sovran/contents/hunch.config.ts?ref=main": { name: "hunch.config.ts" },
      // The org has other apps installed, but not this one — and /apps/<slug> 404s while private.
      "/orgs/SovranBitcoin/installations": { installations: [{ app_slug: "cursor" }, { app_slug: "expo" }] },
    },
  }), { slug: APP });
  expect(find(checks, "Config on main").status).toBe("ok");
  const installed = find(checks, "App installed");
  expect(installed.status).toBe("bad");
  expect(installed.detail).toContain("private App");
  expect(installed.detail).toContain("SovranBitcoin");
  expect(report(checks).failed).toBe(true);
  expect(report(checks).text).toContain("Next:");
});

test("a public App that simply is not installed yet points at the install page", async () => {
  const checks = await diagnose(githubIo({
    local: { "hunch.config.ts": "x" },
    api: {
      "/repos/SovranBitcoin/Sovran": { default_branch: "main", owner: { type: "Organization", login: "SovranBitcoin" } },
      "/repos/SovranBitcoin/Sovran/contents/hunch.config.ts?ref=main": { name: "hunch.config.ts" },
      "/orgs/SovranBitcoin/installations": { installations: [] },
      "/apps/hunch-review": { slug: APP, owner: { login: "Kelbie" } },
    },
  }), { slug: APP });
  expect(find(checks, "App installed").status).toBe("bad");
  expect(find(checks, "App installed").fix).toContain("installations/new");
});

test("a config that exists only in the working tree is the failure it actually is", async () => {
  const checks = await diagnose(githubIo({
    local: { "hunch.config.ts": "x" },
    api: {
      "/repos/SovranBitcoin/Sovran": { default_branch: "main", owner: { type: "Organization", login: "SovranBitcoin" } },
      "/orgs/SovranBitcoin/installations": { installations: [{ app_slug: APP }] },
      "/apps/hunch-review": { slug: APP, owner: { login: "Kelbie" } },
    },
  }), { slug: APP });
  expect(find(checks, "Config in working tree").status).toBe("ok");
  const base = find(checks, "Config on main");
  expect(base.status).toBe("bad");
  expect(base.detail).toContain("reads its rules from the base branch");
  expect(report(checks).text).toContain("Next: commit hunch.config.ts");
});

test("an installed App with a merged config reports nothing missing", async () => {
  const checks = await diagnose(githubIo({
    local: { "hunch.config.ts": "x" },
    api: {
      "/repos/SovranBitcoin/Sovran": { default_branch: "main", owner: { type: "Organization", login: "SovranBitcoin" } },
      "/repos/SovranBitcoin/Sovran/contents/hunch.config.ts?ref=main": { name: "hunch.config.ts" },
      "/orgs/SovranBitcoin/installations": { installations: [{ app_slug: APP }] },
      "/apps/hunch-review": { slug: APP, owner: { login: "Kelbie" } },
    },
  }), { slug: APP });
  expect(report(checks).failed).toBe(false);
  expect(report(checks).text).toContain("Nothing is missing");
});

test("the Actions path is checked for its secret, and a missing one is named", async () => {
  const base = {
    local: { "hunch.toml": "x", ".github/workflows/hunch.yml": "on: pull_request" },
    api: {
      "/repos/SovranBitcoin/Sovran": { default_branch: "main", owner: { type: "Organization", login: "SovranBitcoin" } },
      "/repos/SovranBitcoin/Sovran/contents/hunch.toml?ref=main": { name: "hunch.toml" },
      "/orgs/SovranBitcoin/installations": { installations: [] },
      "/apps/hunch-review": { slug: APP, owner: { login: "Kelbie" } },
    },
  };
  const missing = await diagnose(githubIo(base), { slug: APP });
  expect(find(missing, "Actions workflow").status).toBe("ok");
  expect(find(missing, "Actions secret").status).toBe("bad");
  // With a workflow present, an absent App is not the blocking problem.
  expect(find(missing, "App installed").status).toBe("unknown");

  const set = await diagnose(githubIo({ ...base, api: { ...base.api, "/repos/SovranBitcoin/Sovran/actions/secrets/AI_GATEWAY_API_KEY": { name: "AI_GATEWAY_API_KEY" } } }), { slug: APP });
  expect(find(set, "Actions secret").status).toBe("ok");
});

test("what cannot be established is reported unknown rather than passing", async () => {
  // A user-owned repo: /user/installations needs an App-authorized token, which gh rarely has.
  const unknown = await diagnose(githubIo({
    remote: "https://github.com/someone/private-thing.git",
    local: { "hunch.toml": "x" },
    api: { "/repos/someone/private-thing": { default_branch: "trunk", owner: { type: "User", login: "someone" } } },
  }), { slug: APP });
  expect(find(unknown, "App installed").status).toBe("unknown");
  expect(find(unknown, "App installed").fix).toContain("installations/new");

  // No usable gh at all: local advice only, and no invented claims about GitHub.
  const offline = await diagnose(githubIo({ local: { "hunch.toml": "x" } }), { slug: APP });
  expect(find(offline, "Repository access").status).toBe("unknown");
  expect(offline.some((c) => c.label === "App installed")).toBe(false);

  // Not a GitHub project: stop after the local config rather than guessing.
  const local = await diagnose(githubIo({ remote: null, local: { "hunch.toml": "x" } }), { slug: APP });
  expect(find(local, "GitHub remote").status).toBe("unknown");
  expect(local).toHaveLength(2);
});

test("no config anywhere starts the person at init", async () => {
  const checks = await diagnose(githubIo({ remote: null }), { slug: APP });
  expect(find(checks, "Config in working tree").status).toBe("bad");
  expect(report(checks).text).toContain("Next: npx @kelbie/hunch init");
});
