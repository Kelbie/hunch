import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPacks, parsePackSpec, type PackFetcher } from "../src/packs.js";
import { ConfigError } from "../src/schema.js";

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
