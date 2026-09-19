import { describe, expect, test } from "bun:test";
import { check, rulesFor } from "../src/check.js";
import { parseConfig } from "../src/schema.js";
import { loadConfig } from "../src/load/index.js";
import { collectSources, compileSources, type Lock, selectionHash, staleSources, typesafeClient, summaryMarkdown, toWorkflowCommands } from "../src/index.js";
import { DIFF, fakeJev, memoryRepo } from "./helpers.js";
import { parseHunks } from "../src/diff.js";
import { evaluateConfigSource } from "../src/load/static-ts.js";

describe("adversarial review contracts", () => {
  test("rejects ambiguous configs and unknown config keys", async () => {
    await expect(loadConfig(memoryRepo({ "hunch.toml": "", "hunch.config.ts": "export default {}" }))).rejects.toThrow("exactly one");
    expect(() => parseConfig({ failOnErrors: true }, "test")).toThrow();
    expect(() => evaluateConfigSource('import { defineConfig } from "evil"; export default defineConfig({})')).toThrow();
  });
  test("missing answers fail instead of passing", async () => {
    await expect(check({ config: parseConfig({ rules: { r: ["warn", "Preserve failure"] } }, "t"), hunks: parseHunks(DIFF).slice(0, 1), client: { evaluate: async () => ({ answers: {}, usage: { inputTokens: 1 }, modelId: "fake" }) } })).rejects.toThrow("incomplete answer set");
  });
  test("missing references and exhausted budgets are explicit partial reviews", async () => {
    const client = fakeJev(() => ({ type: "noul", p: 0 })).client;
    const result = await check({ config: parseConfig({ rules: { r: ["warn", { kind: "noul", instructions: "Does hunk violate reference?", reference: "absent.md" }] }, budget: { maxHunks: 1 } }, "t"), hunks: parseHunks(DIFF), client, readFile: async () => null });
    expect(result.complete).toBe(false);
    expect(result.stats.requests).toBe(0);
    expect(result.notices.join()).toContain("not found");
    expect(summaryMarkdown(result)).toContain("Review is incomplete");
  });
  test("direct provider rejects empty distributions", async () => {
    const client = typesafeClient({ apiKey: "fake", fetch: (async () => Response.json({ model: "m", answers: { q: { type: "choice", choice: "bad", probabilities: {} } } })) as unknown as typeof fetch });
    await expect(client.evaluate({ model: "m", state: {}, questions: { q: { type: "choice", instructions: "?", criteria: { good: "Good", bad: "Bad" } } } })).rejects.toThrow("distribution");
  });
  test("gateway-style missing probabilities cannot silently defeat confidence filtering", async () => {
    await expect(check({ config: parseConfig({ rules: { r: ["warn", { kind: "choice", instructions: "?", criteria: { good: "Good", bad: "Bad" }, report: ["bad"], minConfidence: 0.5 }] } }, "t"), hunks: parseHunks(DIFF).slice(0, 1), client: fakeJev(() => ({ type: "choice", choice: "bad", confidence: 0, probabilities: {} })).client })).rejects.toThrow("probabilities");
  });
  test("missing Markdown includes are failures", async () => {
    await expect(collectSources(parseConfig({}, "t"), memoryRepo({ "AGENTS.md": "@missing.md" }))).rejects.toThrow("Missing guidance");
  });
  test("nested AGENTS compile effective guidance and only the deepest result applies", async () => {
    const config = parseConfig({}, "t");
    const docs = await collectSources(config, memoryRepo({ "AGENTS.md": "Use the generic rule", "src/AGENTS.md": "Override generic rule in this package" }));
    expect(docs[1]!.text).toContain("Use the generic rule");
    expect(docs[1]!.text).toContain("Override generic rule");
    const lock = await compileSources(docs, { model: "fixture", extractor: { extract: async ({ sourceId }) => ({ rules: [{ slug: "policy", section: "test", message: sourceId, instructions: "Violation?", criteriaTrue: "yes", criteriaFalse: "no", appliesTo: [], when: null }], notChecked: [] }) } });
    expect(rulesFor("src/foo.ts", config, lock).jev.map((r) => r.id)).toEqual(["agents-md/src/policy"]);
    expect(rulesFor("other/foo.ts", config, lock).jev.map((r) => r.id)).toEqual(["agents-md/root/policy"]);
  });
  test("remote branch selectors stay fresh until their selection changes", async () => {
    const config = parseConfig({ agentsMd: false, skills: [{ repo: "owner/repo", skill: "seo", ref: "main" }] }, "t");
    const lock: Lock = { version: 1, selectionHash: await selectionHash(config), compiler: { model: "fixture" }, sources: [{ id: "skill/seo", kind: "skill", origin: "owner/repo", commit: "a".repeat(40), path: "seo/SKILL.md", hash: "h", scope: "", rules: [], notChecked: [] }] };
    expect(await staleSources(lock, config, memoryRepo({}))).toEqual([]);
    const changed = parseConfig({ agentsMd: false, skills: [{ repo: "owner/repo", skill: "seo", ref: "release" }] }, "t");
    expect(await staleSources(lock, changed, memoryRepo({}))).toContain("guidance selection");
  });
  test("reports escape provider markup and workflow metadata", async () => {
    const result = await check({ config: parseConfig({ rules: { r: ["warn", "Concern"] } }, "t"), hunks: parseHunks(DIFF).slice(0, 1), client: fakeJev(() => ({ type: "noul", p: 1 })).client });
    result.stats.modelIds = ['</sub><img src="bad">'];
    expect(summaryMarkdown(result)).not.toContain('<img');
    result.findings[0]!.file = "file,name\n::error::injected";
    expect(toWorkflowCommands(result.findings)).toContain("file=file%2Cname%0A%3A%3Aerror");
  });
});
