import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPacks, parsePackSpec, resolvePacks, type PackFetcher } from "../src/packs.js";
import { applyPresets } from "../src/load/index.js";
import { parseLock, serializeLock, sha256 } from "../src/lock.js";
import { matchesAny, policyRules, rulesFor } from "../src/check.js";
import { selectionHash, stalePacks } from "../src/skills.js";
import { ConfigError, parseConfig } from "../src/schema.js";

const files: Record<string, object> = {
  "Kelbie/hunch@HEAD:rules/spec.json": { include: ["**/*.md"], rules: { "spec/rfc2119": ["warn", "Does the text use a lowercase requirement word?"] }, budget: { maxRequests: 300 } },
  "acme/policy@v2:rules/payments.json": { include: ["src/**/*.ts"], ignore: ["**/gen/**"], budget: { maxRequests: 9000, concurrency: 8 },
    rules: { "pay/retry": ["error", { kind: "noul", instructions: "Retry repeats a charge?", files: ["src/pay/**"] }], "pay/amount": ["warn", "Amount loses its unit?"] } },
};
const fetcher: PackFetcher = async ({ repo, ref, path }) => {
  const hit = files[`${repo}@${ref}:${path}`];
  return hit ? JSON.stringify(hit) : null;
};

describe("rule packs", () => {
  test.each([
    ["nuts-spec", { repo: "Kelbie/hunch", name: "nuts-spec", ref: "HEAD", path: "rules/nuts-spec.json" }],
    ["acme/policy/payments", { repo: "acme/policy", name: "payments", ref: "HEAD", path: "rules/payments.json" }],
    ["acme/policy/payments@v2", { repo: "acme/policy", name: "payments", ref: "v2", path: "rules/payments.json" }],
    ["nuts-spec@0123abc", { repo: "Kelbie/hunch", name: "nuts-spec", ref: "0123abc" }],
  ] as const)("names a pack the way `skills add` names a skill: %p", (spec, expected) => {
    expect(parsePackSpec(spec)).toMatchObject(expected);
  });

  test("a name that could reach outside the rules folder is refused", () => {
    for (const bad of ["../secrets", "a/b/c/d", "acme/policy/../../x", "acme/policy/pay ments", ""]) expect(() => parsePackSpec(bad)).toThrow(ConfigError);
  });

  test("several packs run together, each rule kept to the files its own pack reviews", async () => {
    const { rules, settings, sources } = await loadPacks(["spec", "acme/policy/payments@v2"], fetcher);
    expect(sources).toEqual(["Kelbie/hunch/spec@HEAD", "acme/policy/payments@v2"]);
    // A markdown rule must not be asked of TypeScript merely because another pack reviews TypeScript.
    expect(rules["spec/rfc2119"]!.question!.files).toEqual(["**/*.md"]);
    expect(rules["pay/amount"]!.question!.files).toEqual(["src/**/*.ts"]);
    // A rule that already says where it applies keeps its own, narrower answer.
    expect(rules["pay/retry"]!.question!.files).toEqual(["src/pay/**"]);
    expect(rules["pay/retry"]!.source).toBe("pack:acme/policy/payments");
    expect(settings.include).toEqual(["**/*.md", "src/**/*.ts"]);
    expect(settings.ignore).toEqual(["**/gen/**"]);
    // The most generous budget any pack asks for, so adding a pack never makes a review partial.
    expect(settings.budget).toMatchObject({ maxRequests: 9000, concurrency: 8 });
  });

  test("a pack is rules, never a way to change where code is sent or what is compiled", async () => {
    for (const key of ["provider", "zeroDataRetention", "model", "skills", "docs", "agentsMd", "failOnError"]) {
      const f: PackFetcher = async () => JSON.stringify({ [key]: key === "provider" ? "typesafe" : false, rules: {} });
      await expect(loadPacks(["x"], f)).rejects.toThrow(`may not set "${key}"`);
    }
  });

  test("a missing or malformed pack says where packs live and what was tried", async () => {
    await expect(loadPacks(["nope"], fetcher)).rejects.toThrow("https://github.com/Kelbie/hunch/tree/HEAD/rules");
    await expect(loadPacks(["x"], async () => "{not json")).rejects.toThrow("not valid JSON");
    await expect(loadPacks(["x"], async () => JSON.stringify({ rules: { a: ["warn"] } }))).rejects.toThrow(ConfigError);
  });

  test("every official pack in rules/ loads, alone and all together", async () => {
    const dir = join(import.meta.dir, "../../../rules");
    const names = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
    expect(names).toContain("nuts-spec");
    const local: PackFetcher = async ({ path }) => readFileSync(join(dir, "..", path), "utf8");
    for (const name of names) expect(Object.keys((await loadPacks([name], local)).rules).length).toBeGreaterThan(0);
    const all = await loadPacks(names, local);
    // Run together, each rule still reviews only the files its own pack names.
    expect(all.rules["errors/codes-used-as-specified"]!.question!.files).toContain("**/*.ts");
    expect(all.settings.budget.maxRequests).toBeGreaterThanOrEqual(100_000);
  });
});

const NUTS = JSON.stringify({
  include: ["**/*.ts", "**/*.rs"],
  rules: {
    "nut11/locktime-boundary": ["error", { kind: "noul", instructions: "Locktime off by one?", criteria: { true: "t", false: "f" }, threshold: 0.9 }],
    "nut11/witness-shape": ["warn", "Witness keeps its shape."],
    "nut12/dleq": ["error", { kind: "noul", instructions: "DLEQ unverified?", files: ["src/mint/**"], when: "dleq", criteria: { true: "t", false: "f" } }],
    "errors/codes": ["warn", { kind: "choice", instructions: "Which code?", criteria: { kept: "k", changed: "c" }, report: ["changed"] }],
  },
});
const pin = { commit: async (_repo: string, ref?: string) => ref ?? "d".repeat(40) };
const servePack = (text = NUTS): PackFetcher => async () => text;

describe("packs named in the config", () => {
  test("a pack becomes one lock entry whose rules are the author's own, pinned to a commit", async () => {
    const [pack] = await resolvePacks(["nuts-spec"], { pin, fetch: servePack() });
    expect(pack).toMatchObject({ id: "pack/nuts-spec", spec: "nuts-spec", origin: "Kelbie/hunch/nuts-spec", commit: "d".repeat(40), path: "rules/nuts-spec.json", select: [] });
    expect(pack!.hash).toBe(await sha256(NUTS));
    // Verbatim: the pack's level, threshold and its own narrower scope all survive the copy.
    expect(pack!.rules["nut11/locktime-boundary"]).toMatchObject({ level: "error", question: { kind: "noul", threshold: 0.9 } });
    expect((pack!.rules["nut12/dleq"]!.question as { files?: string[] }).files).toEqual(["src/mint/**"]);
    // A rule with no scope of its own inherits the pack's, as `--pack` also does.
    expect((pack!.rules["nut11/witness-shape"]!.question as { files?: string[] }).files).toEqual(["**/*.ts", "**/*.rs"]);
    // A question that is not a noul is copied as itself, not flattened.
    expect(pack!.rules["errors/codes"]!.question.kind).toBe("choice");
  });

  test("a pinned ref is asked for by name, and a lock survives the round trip through the schema", async () => {
    const packs = await resolvePacks(["owner/repo/payments@v2"], { pin, fetch: servePack() });
    expect(packs[0]).toMatchObject({ id: "pack/payments", origin: "owner/repo/payments", commit: "v2" });
    const text = serializeLock({ version: 1, compiler: { model: "none" }, sources: [], packs });
    const parsed = parseLock(text);
    expect(parsed.packs?.[0]!.rules["nut12/dleq"]!.question).toEqual(packs[0]!.rules["nut12/dleq"]!.question);
  });

  test("a selection keeps the ids it names and nothing else, and a pattern that matches nothing fails", async () => {
    const [pack] = await resolvePacks([{ pack: "nuts-spec", rules: ["nut11/*", "errors/codes"] }], { pin, fetch: servePack() });
    expect(Object.keys(pack!.rules).sort()).toEqual(["errors/codes", "nut11/locktime-boundary", "nut11/witness-shape"]);
    expect(pack!.select).toEqual(["nut11/*", "errors/codes"]);
    // Silently reviewing nothing is the failure this prevents.
    await expect(resolvePacks([{ pack: "nuts-spec", rules: ["nut11/locktime-boundry"] }], { pin, fetch: servePack() }))
      .rejects.toThrow('has no rule matching "nut11/locktime-boundry"');
  });

  test("a pack in the config may not decide where code is sent, or that a level cannot be re-levelled", async () => {
    const bad = JSON.stringify({ failOnError: true, rules: {} });
    await expect(resolvePacks(["nuts-spec"], { pin, fetch: servePack(bad) })).rejects.toThrow('may not set "failOnError"');
    const levelOnly = JSON.stringify({ rules: { "someone/elses-rule": "off" } });
    await expect(resolvePacks(["nuts-spec"], { pin, fetch: servePack(levelOnly) })).rejects.toThrow("defines no question");
    await expect(resolvePacks(["nuts-spec"], { pin, fetch: async () => null })).rejects.toThrow("Packs live in a repository's rules/ folder");
  });

  test("the same pack twice is refused, because it would apply twice", async () => {
    await expect(resolvePacks(["nuts-spec", "nuts-spec@v2"], { pin, fetch: servePack() })).rejects.toThrow("named twice");
  });
});

describe("a pack's rules as the policy applies them", () => {
  const configWith = (raw: Record<string, unknown> = {}) => applyPresets(parseConfig({ include: ["**/*"], ...raw }, "test"));
  const lockWith = async (packs: string[] | Record<string, unknown>[]) =>
    ({ version: 1 as const, compiler: { model: "none" }, sources: [], packs: await resolvePacks(packs as never, { pin, fetch: servePack() }) });

  test("pack rules are asked with their own level, and only of the files their pack reviews", async () => {
    const lock = await lockWith(["nuts-spec"]);
    const rules = policyRules(configWith(), lock);
    expect(rules.find((r) => r.id === "nut11/locktime-boundary")).toMatchObject({ level: "error", source: "pack:Kelbie/hunch/nuts-spec", compiled: false });
    // `files` decides where, exactly as it does for a rule written in the config.
    expect(rulesFor("src/mint/dleq.ts", configWith(), lock).jev.map((r) => r.id)).toContain("nut12/dleq");
    expect(rulesFor("src/wallet/send.ts", configWith(), lock).jev.map((r) => r.id)).not.toContain("nut12/dleq");
    expect(rulesFor("README.md", configWith(), lock).jev).toEqual([]);
  });

  test("the config re-levels a pack rule, switches one off by glob, and replaces one outright", async () => {
    const lock = await lockWith(["nuts-spec"]);
    const config = configWith({ rules: {
      "nut11/locktime-boundary": "warn",
      "nut12/*": "off",
      "nut11/witness-shape": ["error", "Our own sentence."],
    } });
    const rules = policyRules(config, lock);
    expect(rules.find((r) => r.id === "nut11/locktime-boundary")!.level).toBe("warn");
    expect(rules.find((r) => r.id === "nut12/dleq")!.level).toBe("off");
    const replaced = rules.filter((r) => r.id === "nut11/witness-shape");
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatchObject({ level: "error", source: "config" });
    expect(replaced[0]!.question.message).toBe("Our own sentence.");
    const asked = rulesFor("src/mint/dleq.ts", config, lock).jev.map((r) => r.id);
    expect(asked).not.toContain("nut12/dleq");
    expect(asked).toContain("nut11/locktime-boundary");
  });

  test("a level for a pack rule id is not mistaken for a typo, and a real typo still is", async () => {
    const lock = await lockWith(["nuts-spec"]);
    expect(() => rulesFor("src/a.ts", configWith({ rules: { "nut11/witness-shape": "error" } }), lock)).not.toThrow();
    expect(() => rulesFor("src/a.ts", configWith({ rules: { "nut11/no-such-rule": "error" } }), lock)).toThrow('rule "nut11/no-such-rule" has no question');
  });

  test("two sources cannot claim one rule id", async () => {
    const lock = await lockWith(["nuts-spec"]);
    const clash = serializeLock({ ...lock, sources: [{ id: "skill/x", kind: "skill", origin: "./x", path: "x/SKILL.md", scope: "", hash: "h", notChecked: [],
      rules: [{ id: "nut12/dleq", section: "s", message: "m", instructions: "i", criteria: { true: "t", false: "f" }, appliesTo: [] }] }] });
    expect(() => parseLock(clash)).toThrow("duplicate rule ids");
  });
});

describe("packs the lock does not cover", () => {
  const cfg = (packs: unknown[]) => applyPresets(parseConfig({ packs }, "test"));
  const installed = (spec: string, select: string[] = []) => ({ version: 1 as const, compiler: { model: "none" }, sources: [],
    packs: [{ id: `pack/${parsePackSpec(spec).name}`, spec, origin: "Kelbie/hunch/x", commit: "c", path: "rules/x.json", hash: "h", select, rules: {} }] });

  test("a pack is stale when it is added, dropped, re-pinned or re-selected, and current otherwise", () => {
    expect(stalePacks(null, cfg(["nuts-spec"]))).toEqual(["pack/nuts-spec"]);
    expect(stalePacks(installed("nuts-spec"), cfg(["nuts-spec"]))).toEqual([]);
    expect(stalePacks(installed("nuts-spec"), cfg([]))).toEqual(["pack/nuts-spec"]);
    expect(stalePacks(installed("nuts-spec"), cfg(["nuts-spec@v2"]))).toEqual(["pack/nuts-spec"]);
    expect(stalePacks(installed("nuts-spec"), cfg([{ pack: "nuts-spec", rules: ["nut11/*"] }]))).toEqual(["pack/nuts-spec"]);
    expect(stalePacks(installed("nuts-spec", ["nut11/*"]), cfg([{ pack: "nuts-spec", rules: ["nut11/*"] }]))).toEqual([]);
  });

  test("a config with no packs leaves the lock's currency judgement untouched", async () => {
    const lock = { version: 1 as const, compiler: { model: "none" }, sources: [] };
    expect(await selectionHash(applyPresets(parseConfig({}, "test")))).toBe(await selectionHash(applyPresets(parseConfig({ packs: [] }, "test"))));
    expect(stalePacks(lock, applyPresets(parseConfig({}, "test")))).toEqual([]);
  });
});

describe("choosing some of a pack's rules by name", () => {
  test("a spec carries its selection after #, because a slash cannot tell a pack from a rule", () => {
    expect(parsePackSpec("nuts-spec")).toMatchObject({ name: "nuts-spec", ref: "HEAD", select: [] });
    expect(parsePackSpec("nuts-spec#nut11/*")).toMatchObject({ repo: "Kelbie/hunch", name: "nuts-spec", select: ["nut11/*"] });
    expect(parsePackSpec("owner/repo/payments@v2#pay/retry, pay/amount")).toMatchObject({ repo: "owner/repo", name: "payments", ref: "v2", select: ["pay/retry", "pay/amount"] });
    // `a/b/c` is already a whole pack name, so a slash-joined rule path is refused rather than guessed at.
    expect(() => parsePackSpec("Kelbie/hunch/nuts-spec/nut01/mint-pubkey-format")).toThrow("optionally with @ref and #rule,rule");
    expect(() => parsePackSpec("nuts-spec#")).toThrow('names no rule after "#"');
    expect(() => parsePackSpec("nuts-spec#nut11/a b")).toThrow("an id or a glob");
  });

  test("--pack with a selection asks only those rules, and a pattern that matches nothing fails", async () => {
    const { rules, sources } = await loadPacks(["nuts-spec#nut11/*"], servePack());
    expect(Object.keys(rules).sort()).toEqual(["nut11/locktime-boundary", "nut11/witness-shape"]);
    // The report names what was asked for, selection included.
    expect(sources).toEqual(["Kelbie/hunch/nuts-spec@HEAD#nut11/*"]);
    await expect(loadPacks(["nuts-spec#nut99/*"], servePack())).rejects.toThrow('has no rule matching "nut99/*"');
  });

  test("the config accepts the same spelling, and refuses to have it both ways", async () => {
    const [pack] = await resolvePacks(["nuts-spec#nut12/*"], { pin, fetch: servePack() });
    expect(Object.keys(pack!.rules)).toEqual(["nut12/dleq"]);
    expect(pack!.select).toEqual(["nut12/*"]);
    await expect(resolvePacks([{ pack: "nuts-spec#nut11/*", rules: ["nut12/*"] }], { pin, fetch: servePack() }))
      .rejects.toThrow("selects rules twice");
    // The spec is what the lock records, so changing the selection makes it stale either way.
    expect(stalePacks({ version: 1, compiler: { model: "none" }, sources: [], packs: [pack!] }, applyPresets(parseConfig({ packs: ["nuts-spec#nut11/*"] }, "t")))).toEqual(["pack/nuts-spec"]);
  });

  test("--only keeps rules by id or glob, whatever defined them", async () => {
    const lock = { version: 1 as const, compiler: { model: "none" }, sources: [], packs: await resolvePacks(["nuts-spec"], { pin, fetch: servePack() }) };
    const config = applyPresets(parseConfig({ include: ["**/*"], rules: { "mine/own": ["warn", "Ours."] } }, "t"));
    const asked = (only: string[]) => rulesFor("src/mint/dleq.ts", config, lock, only).jev.map((r) => r.id).sort();
    expect(asked(["nut11/*"])).toEqual(["nut11/locktime-boundary", "nut11/witness-shape"]);
    expect(asked(["nut12/dleq"])).toEqual(["nut12/dleq"]);
    expect(asked(["nut11/*", "mine/own"])).toEqual(["mine/own", "nut11/locktime-boundary", "nut11/witness-shape"]);
    expect(asked(["nut99/*"])).toEqual([]);
    expect(matchesAny("nut11/locktime-boundary", ["nut11/*"])).toBe(true);
    expect(matchesAny("nut110/x", ["nut11/*"])).toBe(false);
  });
});
