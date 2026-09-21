import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/inline.js";
import type { RepoReader } from "../../core/src/index.js";

const repoWith = (files: Record<string, string>): RepoReader => ({
  read: async (p) => files[p] ?? null, list: async () => [], files: async () => Object.keys(files),
});
const toml = repoWith({ "hunch.toml": '[rules]\n"repo/rule" = ["warn", "From the repository."]' });

test("--config JSON replaces the repository config and leaves out skills and AGENTS.md", async () => {
  const r = (await resolveConfig(toml, { config: [JSON.stringify({ extends: ["hunch:recommended"], rules: {
    "nuts/json": { level: "error", noul: "Does `hunk` add invalid JSON?", files: ["**/*.md"], threshold: 0.8 },
    "nuts/plain": ["warn", "Examples match the text."],
  } })] }))!;
  expect(r.path).toBe("--config");
  expect(r.config.rules["repo/rule"]).toBeUndefined();
  expect(r.config.rules["nuts/json"]).toMatchObject({ level: "error", question: { kind: "noul", threshold: 0.8, files: ["**/*.md"] } });
  expect(r.config.rules["failures/misleading-success"]?.source).toBe("hunch:recommended");
  expect(r.config.skills).toEqual([]);
  expect(r.config.agentsMd).toBe(false);
});

test("--config reads a file or stdin, and explains bad input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-inline-"));
  try {
    writeFileSync(join(dir, "rules.json"), JSON.stringify({ agentsMd: true, rules: { a: ["warn", "A."] } }));
    expect((await resolveConfig(toml, { config: [join(dir, "rules.json")] }))!.config.agentsMd).toBe(true);
    expect(Object.keys((await resolveConfig(toml, { config: ["-"], stdin: () => '{"rules":{"b":["error","B."]}}' }))!.config.rules)).toEqual(["b"]);
    await expect(resolveConfig(toml, { config: ["{rules:"] })).rejects.toThrow("not valid JSON");
    await expect(resolveConfig(toml, { config: [join(dir, "missing.json")] })).rejects.toThrow("can't read");
    await expect(resolveConfig(toml, { config: ['{"rulez":{}}'] })).rejects.toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("repeated --config layers overrides; rules and budget merge key by key", async () => {
  const r = (await resolveConfig(toml, { config: [
    '{"zeroDataRetention":true,"budget":{"maxHunks":300},"rules":{"a":["warn","A."],"b":["warn","B."]}}',
    '{"zeroDataRetention":false,"budget":{"maxRequests":5},"rules":{"b":"off"}}',
  ] }))!;
  expect(r.config.zeroDataRetention).toBe(false);
  expect(r.config.budget).toMatchObject({ maxHunks: 300, maxRequests: 5 });
  expect(r.config.rules.a?.level).toBe("warn");
  expect(r.config.rules.b?.level).toBe("off");
});

test("--rule adds plain-English warn rules to the repository config, or works alone", async () => {
  const withRepo = (await resolveConfig(toml, { rules: ["api/errors=Error responses keep their code field.", "x=Y = Z."] }))!;
  expect(Object.keys(withRepo.config.rules)).toEqual(["repo/rule", "api/errors", "x"]);
  expect(withRepo.config.rules.x?.question?.instructions).toContain("Y = Z.");
  const alone = (await resolveConfig(repoWith({}), { rules: ["a=A."] }))!;
  expect(alone.path).toBe("--rule");
  expect(alone.config.agentsMd).toBe(false);
  await expect(resolveConfig(toml, { rules: ["no equals sign"] })).rejects.toThrow("id=Plain-English");
  expect(await resolveConfig(repoWith({}), {})).toBeNull();
});

test("a --config file path is relative to where the run was told it started, not to the process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hunch-inline-"));
  writeFileSync(join(dir, "rules.json"), JSON.stringify({ rules: { "a/b": ["error", "Keep it."] } }));
  const repo = { read: async () => null, list: async () => [], files: async () => [] };

  const resolved = await resolveConfig(repo, { config: ["rules.json"], root: dir });
  expect(resolved!.config.rules["a/b"]!.level).toBe("error");

  // Without the root it is read from the process directory, where it does not exist.
  await expect(resolveConfig(repo, { config: ["rules.json"] })).rejects.toThrow("can't read");
});

test("--pack reviews an unconfigured repository; --config and --rule still layer over it", async () => {
  const packs: Record<string, object> = {
    "rules/spec.json": { include: ["**/*.md"], budget: { maxRequests: 500 }, rules: { "spec/rfc2119": ["warn", "Lowercase requirement word?"] } },
    "rules/code.json": { include: ["**/*.ts"], rules: { "code/verify": ["error", "Signature checked over the wrong message?"] } },
  };
  const r = (await resolveConfig(repoWith({}), {
    packs: ["spec", "acme/policy/code@v1"],
    config: ['{"budget":{"concurrency":2},"rules":{"spec/rfc2119":"off"}}'],
    rules: ["mine/extra=Anything else?"],
    fetchPack: async ({ path }) => (packs[path] ? JSON.stringify(packs[path]) : null),
  }))!;
  expect(r.packs).toEqual(["Kelbie/hunch/spec@HEAD", "acme/policy/code@v1"]);
  expect(r.config.include).toEqual(["**/*.md", "**/*.ts"]);
  // The pack's budget stands where --config says nothing, and --config wins where it speaks.
  expect(r.config.budget).toMatchObject({ maxRequests: 500, concurrency: 2 });
  // A bare level silences a pack rule without restating its question.
  expect(r.config.rules["spec/rfc2119"]).toMatchObject({ level: "off", question: { files: ["**/*.md"] } });
  expect(r.config.rules["code/verify"]).toMatchObject({ level: "error", source: "pack:acme/policy/code", question: { files: ["**/*.ts"] } });
  expect(r.config.rules["mine/extra"]?.level).toBe("warn");
  expect(r.config.skills).toEqual([]);
});
