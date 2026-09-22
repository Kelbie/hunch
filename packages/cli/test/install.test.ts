import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/local.js";

/**
 * `install` writes the policy, so what matters here is what it says before spending anything: which
 * packs and sources it would touch, and that it refuses clearly when there is nothing to install.
 * The dry run compares the config with the lock and fetches nothing, so these stay offline.
 */
const BIN = join(import.meta.dir, "../src/bin.ts");

function hunch(cwd: string, ...args: string[]) {
  const r = spawnSync("bun", [BIN, ...args], { cwd, encoding: "utf8", env: { PATH: process.env.PATH!, HUNCH_CONFIG_DIR: "/nonexistent/hunch-test-config" } });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

function project(config: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hunch-install-"));
  writeFileSync(join(dir, "hunch.config.ts"), config);
  // Hunch reads files through git, as it does in a real repository.
  git(dir, ["init", "--quiet", "-b", "main"]);
  git(dir, ["add", "."]);
  git(dir, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "--quiet", "-m", "base"]);
  return dir;
}

test("a dry run names the packs the config asks for, the rules it selected, and costs nothing", () => {
  const dir = project(`export default {
  include: ["src/**"],
  agentsMd: false,
  skills: [],
  packs: ["nuts-spec", { pack: "bips-spec", rules: ["bip32/*"] }],
};
`);
  try {
    const r = hunch(dir, "install", "--dry-run");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("2 pack(s) would be copied");
    expect(r.stdout).toContain("new        pack/nuts-spec  nuts-spec");
    expect(r.stdout).toContain("new        pack/bips-spec  bips-spec");
    expect(r.stdout).toContain("Packs are copied verbatim");

    const json = hunch(dir, "install", "--dry-run", "--reporter", "json");
    expect(JSON.parse(json.stdout).packs).toEqual([
      { id: "pack/nuts-spec", spec: "nuts-spec", rules: null, status: "new" },
      { id: "pack/bips-spec", spec: "bips-spec", rules: null, status: "new" },
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("`compile` still means `install`, so an older command line keeps working", () => {
  const dir = project(`export default { packs: ["nuts-spec"], agentsMd: false, skills: [] };\n`);
  try {
    expect(hunch(dir, "compile", "--dry-run").stdout).toContain("pack/nuts-spec");
    expect(hunch(dir, "i", "--dry-run").stdout).toContain("pack/nuts-spec");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("with nothing to install it says so, and names both ways to give it something", () => {
  const dir = project(`export default { agentsMd: false, skills: [] };\n`);
  try {
    const r = hunch(dir, "install", "--dry-run");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("nothing to install");
    expect(r.stderr).toContain('packs: ["nuts-spec"]');
    expect(r.stderr).toContain("npx skills add");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--packs-only without a pack in the config is refused rather than quietly doing nothing", () => {
  const dir = project(`export default { agentsMd: false, skills: [] };\n`);
  try {
    const r = hunch(dir, "install", "--packs-only");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--packs-only, but the config names no pack");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a mistyped pack name fails the config before any install is attempted", () => {
  const dir = project(`export default { packs: [{ pack: "nuts-spec", rules: [] }], agentsMd: false, skills: [] };\n`);
  try {
    const r = hunch(dir, "install", "--dry-run");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("packs.0.rules");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an inline config leaves the installed policy out of the run, rather than asking both", () => {
  const dir = project(`export default { include: ["src/**"], agentsMd: false, skills: [], rules: { "mine/own": ["warn", "Ours."] } };\n`);
  try {
    writeFileSync(join(dir, "hunch.lock"), JSON.stringify({
      version: 1, compiler: { model: "none" }, sources: [],
      packs: [{ id: "pack/x", spec: "owner/repo/x", origin: "owner/repo/x", commit: "c", path: "rules/x.json", hash: "h", select: [],
        rules: { "installed/rule": { level: "error", question: { kind: "noul", instructions: "Installed?", criteria: { true: "t", false: "f" }, threshold: 0.7 } } } }],
    }));
    const own = JSON.parse(hunch(dir, "config", "--reporter", "json").stdout);
    expect(own.rules.map((r: { id: string }) => r.id).sort()).toEqual(["installed/rule", "mine/own"]);

    const inline = JSON.parse(hunch(dir, "config", "--reporter", "json", "--config", '{"rules":{"just/this":["warn","Only this one."]}}').stdout);
    expect(inline.rules.map((r: { id: string }) => r.id)).toEqual(["just/this"]);
    expect(inline.problems).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
