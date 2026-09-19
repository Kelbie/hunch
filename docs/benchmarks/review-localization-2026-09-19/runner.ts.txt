/** Controlled detection/localization probe; synthetic examples are not repository-level quality evidence. */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { check, parseConfig, parseHunks, clientFromEnv } from "../packages/core/src/index.js";

const output = resolve(process.argv[2] ?? "docs/benchmarks/review-localization-2026-09-19");
if (!process.argv.includes("--live")) throw new Error("Pass an output directory followed by --live for public synthetic Jev calls");
if (existsSync(output)) throw new Error("Use a fresh output directory; existing evidence is never overwritten");
mkdirSync(output, { recursive: true });
const lines = Array.from({ length: 32 }, (_, i) => `const padding${i} = ${i};`);
lines.splice(24, 7, "export async function pay() {", "  try { await charge(); }", "  catch (error) {", "    return { ok: true };", "  }", "  return { ok: true };", "}");
const multiple = [...lines];
multiple.splice(3, 7, "export async function refund() {", "  try { await refundCharge(); }", "  catch (error) {", "    return { ok: true };", "  }", "  return { ok: true };", "}");
const safe = lines.map((line, index) => index === 27 ? "    return { ok: false, error };" : line);
const added = (source: string[]) => `--- /dev/null\n+++ b/pay.ts\n@@ -0,0 +1,${source.length} @@\n${source.map(line => `+${line}`).join("\n")}\n`;
const cases = [
  { id: "tail-failure", source: lines.join("\n"), diff: added(lines), targets: [28] },
  { id: "two-failures", source: multiple.join("\n"), diff: added(multiple), targets: [7, 28] },
  { id: "preserved-error", source: safe.join("\n"), diff: added(safe), targets: [] },
  { id: "small-edit-needs-catch-context", source: lines.join("\n"), diff: "--- a/pay.ts\n+++ b/pay.ts\n@@ -28 +28 @@\n-    return { ok: false, error };\n+    return { ok: true };\n", targets: [28] },
  { id: "unrelated-edit-near-old-defect", source: lines.map((line, index) => index === 0 ? "const padding0 = 1;" : line).join("\n"), diff: "--- a/pay.ts\n+++ b/pay.ts\n@@ -1 +1 @@\n-const padding0 = 0;\n+const padding0 = 1;\n", targets: [] },
];
const variants = [
  { id: "patch-only", chunkLines: 150, contextLines: 0, localize: false },
  { id: "small-with-context", chunkLines: 8, contextLines: 40, localize: false },
  { id: "contextual", chunkLines: 150, contextLines: 40, localize: false },
  { id: "localized", chunkLines: 150, contextLines: 40, localize: true },
];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const implementation = ["check", "context", "localize", "diff", "jev", "schema"].map(name => ({ path: `packages/core/src/${name}.ts`, sha256: hash(readFileSync(`packages/core/src/${name}.ts`, "utf8")) }));
writeFileSync(join(output, "manifest.json"), JSON.stringify({ cases, variants, implementation, runnerHash: hash(readFileSync(import.meta.path, "utf8")), annotation: "Agent-authored synthetic local behavior probes, fixed before evaluation. Not an independent benchmark." }, null, 2));
const client = clientFromEnv({ provider: "gateway", zeroDataRetention: false });
const rows = [];
for (const item of cases) for (const variant of variants) {
  const config = parseConfig({ agentsMd: false, zeroDataRetention: false, review: { ...Object.fromEntries(Object.entries(variant).filter(([key]) => key !== "id")), localizationLines: 4, maxLocalizationRequests: 64 }, budget: { maxRequests: 128, timeoutSeconds: 180 },
    rules: { failure: ["warn", { kind: "noul", threshold: 0.7, instructions: "Does the change make a catch handler return a successful payment or refund result after the operation threw, rather than preserve the error?", message: "A caught payment failure is converted into success." }] } }, "review-probe");
  const start = performance.now();
  const result = await check({ config, hunks: parseHunks(item.diff), client, readChangedFile: async () => item.source });
  writeFileSync(join(output, `${item.id}--${variant.id}.json`), JSON.stringify({ startedAt: new Date().toISOString(), caseId: item.id, variant, elapsedMs: performance.now() - start, result }, null, 2));
  if (!result.complete) throw new Error("Incomplete probe preserved; no complete aggregate published");
  const covered = new Set(result.findings.flatMap(f => Array.from({ length: f.endLine - f.line + 1 }, (_, index) => f.line + index)));
  const row = { caseId: item.id, variant: variant.id, expectedTargets: item.targets.length, recovered: item.targets.filter(line => covered.has(line)).length,
    findings: result.findings.length, indicatedLines: covered.size, requests: result.stats.requests, inputTokens: result.stats.inputTokens };
  rows.push(row);
  console.log(JSON.stringify(row));
}
writeFileSync(join(output, "summary.json"), JSON.stringify(rows, null, 2));
