import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/local.js";

const BIN = join(import.meta.dir, "../src/bin.ts");
// No rules, so the CLI never needs a provider; stats still show what would be reviewed.
const CONFIG = "export default { include: ['src/**'] };\n";

function hunch(cwd: string, ...args: string[]) {
  const r = spawnSync("bun", [BIN, "check", "--reporter", "json", ...args], { cwd, encoding: "utf8", env: { PATH: process.env.PATH! } });
  const out = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  return { hunks: out?.stats.hunks as number, files: [...new Set<string>(out?.findings.map((f: { file: string }) => f.file) ?? [])], stderr: r.stderr, status: r.status };
}

test("--all reviews whole files at the working tree or a branch, filtered by path", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-all-"));
  try {
    mkdirSync(join(root, "src/send"), { recursive: true });
    writeFileSync(join(root, "hunch.config.ts"), CONFIG);
    writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "src/send/b.ts"), "export const b = 2;\n");
    writeFileSync(join(root, "src/yarn.lock"), "lock\n");
    git(root, ["init", "--quiet", "-b", "main"]);
    git(root, ["add", "."]);
    git(root, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "--quiet", "-m", "base"]);
    git(root, ["switch", "--quiet", "-c", "feature"]);
    writeFileSync(join(root, "src/c.ts"), "export const c = 3;\n");
    git(root, ["add", "."]);
    git(root, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "--quiet", "-m", "c"]);

    // Whole working tree: three source files, the lockfile is ignored by default.
    expect(hunch(root, "--all").hunks).toBe(3);
    // A branch in full, without checking it out.
    expect(hunch(root, "--all", "--head", "main").hunks).toBe(2);
    // Path filters narrow either mode.
    expect(hunch(root, "--all", "src/send").hunks).toBe(1);
    // Diff mode still reviews only the change.
    expect(hunch(root, "--base", "main").hunks).toBe(1);
    const both = hunch(root, "--all", "--base", "main");
    expect(both.status).toBe(2);
    expect(both.stderr).toContain("--all reviews whole files");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the PR that adds Hunch is skipped with a notice, not failed, when its base has no config", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-first-"));
  try {
    git(root, ["init", "--quiet", "-b", "main"]);
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
    git(root, ["add", "."]);
    git(root, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "--quiet", "-m", "base"]);
    const base = git(root, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(root, "hunch.config.ts"), CONFIG);
    git(root, ["add", "."]);
    git(root, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "--quiet", "-m", "add hunch"]);
    const r = spawnSync("bun", [BIN, "check", "--base", base, "--head", "HEAD", "--policy-ref", base, "--reporter", "github"], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH! } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("::notice title=Hunch::Hunch isn't set up on the base branch yet");
    // Without a trusted base policy flag, a missing config is still an error.
    expect(spawnSync("bun", [BIN, "check", "--base", base], { cwd: mkdtempSync(join(tmpdir(), "hunch-none-")), encoding: "utf8", env: { PATH: process.env.PATH! } }).status).not.toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
