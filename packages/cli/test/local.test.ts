import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localRepo, gitRepo, git } from "../src/local.js";

test("repository readers reject traversal/escaping symlinks and preserve trusted base content", async () => {
  const temp = mkdtempSync(join(tmpdir(), "hunch-reader-"));
  try {
    const root = join(temp, "repo"); mkdirSync(root);
    writeFileSync(join(temp, "private.md"), "private");
    symlinkSync(join(temp, "private.md"), join(root, "escape.md"));
    const repo = localRepo(root);
    await expect(repo.read("../private.md")).rejects.toThrow();
    await expect(repo.read("escape.md")).rejects.toThrow("escapes");
    await expect(repo.read(".env.local")).rejects.toThrow();
    expect(await repo.read("missing.md")).toBeNull();
    git(root, ["init", "--quiet"]);
    writeFileSync(join(root, "policy.md"), "trusted");
    git(root, ["add", "policy.md"]);
    git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "base"]);
    writeFileSync(join(root, "policy.md"), "untrusted");
    expect(await gitRepo(root, "HEAD").read("policy.md")).toBe("trusted");
    expect(await repo.read("policy.md")).toBe("untrusted");
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
