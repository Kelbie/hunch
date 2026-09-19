import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git } from "../src/local.js";

const BIN = join(import.meta.dir, "../src/bin.ts");

function withRepo(files: Record<string, string>, run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "hunch-find-test-"));
  try {
    // No credentials or network: a provider accidentally used here fails immediately.
    const fixture = { "hunch.config.ts": 'export default { provider: "typesafe", include: ["src/**"], agentsMd: false, rules: { failures: ["warn", "Preserve failures."] } };', ...files };
    for (const [file, text] of Object.entries(fixture)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    git(root, ["init", "--quiet", "-b", "main"]);
    run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function hunch(cwd: string, args: string[]) {
  return spawnSync("bun", [BIN, ...args], { cwd, encoding: "utf8", env: { PATH: process.env.PATH! }, timeout: 10_000 });
}

test("CLI plans condition and task sweeps with the requested windows without calling a provider", () => {
  withRepo({ "src/flow.ts": "a();\nb();\nc();\nd();\ne();\nf();\ng();\nh();", "src/yarn.lock": "excluded" }, root => {
    const flags = ["--chunk-lines", "4", "--overlap-lines", "2", "--top", "0", "--dry-run"];
    const condition = hunch(root, ["find", "Does this code discard a failure?", "--mode", "condition", ...flags]);
    expect(condition.status).toBe(0);
    expect(condition.stdout).toContain("1 file(s) as 3 chunk(s): 3 request(s), 3 question(s)");
    const task = hunch(root, ["find", "add cancellation", "--facet", "edit,test", ...flags]);
    expect(task.status).toBe(0);
    expect(task.stdout).toContain("3 request(s), 6 question(s)");
  });
});

test.each([
  ["find", ["find", "locate writes"]],
  ["check --all", ["check", "--all"]],
] as const)("%s reports an entirely skipped corpus as incomplete JSON and exit 2", (_label, command) => {
  withRepo({ "src/blob.bin": "\0binary" }, root => {
    const result = hunch(root, [...command, "--reporter", "json"]);
    expect(result.status).toBe(2);
    expect(result.stdout.trim()).toStartWith("{");
    const report = JSON.parse(result.stdout);
    expect(report.complete).toBe(false);
    expect(report.stats.requests).toBe(0);
    expect(report.notices.join(" ")).toContain("src/blob.bin");
    expect(hunch(root, [...command, "--dry-run"]).status).toBe(2);
  });
});

const invalidOptions: [string[], string][] = [
  [["--mode", "unknown"], "--mode must be task or condition"],
  [["--mode", "condition", "--facet", "edit"], "--facet and --prs apply to task mode only"],
  [["--mode", "condition", "--prs"], "--facet and --prs apply to task mode only"],
  [["--chunk-lines", "0"], "--chunk-lines must be between"],
  [["--chunk-lines", "4", "--overlap-lines", "4"], "--overlap-lines must be nonnegative and less"],
];
test.each(invalidOptions)("CLI refuses invalid search options %j before evaluation", (flags, message) => {
  withRepo({ "src/a.ts": "write();" }, root => {
    const result = hunch(root, ["find", "locate writes", ...flags]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(message);
    expect(result.stdout).toBe("");
  });
});

test("CLI preserves the query and scope in JSON when the provider is unavailable", () => {
  withRepo({ "src/a.ts": "write();", "src/yarn.lock": "excluded" }, root => {
    const query = "Does this code discard a failed write?";
    const result = hunch(root, ["find", query, "--mode", "condition", "--top", "0", "--chunk-lines", "4", "--overlap-lines", "1", "--reporter", "json"]);
    expect(result.status).toBe(2);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ query, mode: "condition", complete: false, matches: [], stats: { chunks: 1, requests: 1, scored: 0 } });
    expect(report.scope).toMatchObject({ include: ["src/**"], paths: [], chunkLines: 4, overlapLines: 1, skippedFiles: [], revision: "working-tree" });
    expect(report.scope.ignore).toContain("**/yarn.lock");
    expect(report.notices.join(" ")).toContain("src/a.ts:1");
  });
});


test("Actions CLI reads immutable base policy and links its summary to the reviewed head", () => {
  withRepo({ "hunch.config.ts": 'export default { agentsMd: false, skills: [], include: ["src/**"], rules: { scoped: ["warn", {kind:"noul", instructions:"Preserve failures", files:["other/**"]}] } };', "src/a.ts": "before();\n" }, root => {
    const commit = () => { git(root, ["add", "."]); git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]); return git(root, ["rev-parse", "HEAD"]).trim(); };
    const base = commit();
    writeFileSync(join(root, "src/a.ts"), "after();\n");
    writeFileSync(join(root, "hunch.config.ts"), 'throw new Error("UNTRUSTED HEAD CONFIG EXECUTED");');
    const head = commit();
    git(root, ["checkout", "--quiet", base]);
    const summary = join(root, "summary.md");
    const result = spawnSync("bun", [BIN, "check", "--cwd", root, "--base", base, "--head", head, "--policy-ref", base, "--reporter", "github"], {
      cwd: root, encoding: "utf8", timeout: 10_000,
      env: { PATH: process.env.PATH!, GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "owner/repo", GITHUB_STEP_SUMMARY: summary },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("UNTRUSTED");
    expect(readFileSync(summary, "utf8")).toContain(`https://github.com/owner/repo/blob/${head}`);
    expect(readFileSync(summary, "utf8")).toContain("review complete");
  });
});

test("check dry-run counts configured diff windows", () => {
  withRepo({ "hunch.config.ts": 'export default { agentsMd:false, skills:[], review:{chunkLines:2}, rules:{a:["warn","Preserve failures."]} };' }, root => {
    writeFileSync(join(root, "patch.diff"), "--- /dev/null\n+++ b/f.ts\n@@ -0,0 +1,5 @@\n+a();\n+b();\n+c();\n+d();\n+e();\n");
    const result = hunch(root, ["check", "--diff", join(root, "patch.diff"), "--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("3 hunk(s): 3 question(s) in 3 request(s)");
  });
});
