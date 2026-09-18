// Sends only the checked-in synthetic fixtures, never the repository diff or guidance.
import { readFileSync, readdirSync } from "node:fs";
import { applyPresets, check, gatewayClient, parseConfig, parseHunks } from "../packages/core/src/index.js";

const zeroDataRetention = process.env.HUNCH_SMOKE_ZDR !== "false";
const config = applyPresets(parseConfig({
  extends: ["hunch:recommended", "hunch:typescript", "hunch:rust"],
  agentsMd: false,
}, "synthetic-presets"));
const client = gatewayClient({ zeroDataRetention });
const directory = new URL("../examples/presets/", import.meta.url);
let mismatches = 0;
try {
  for (const file of readdirSync(directory).filter(f => f.endsWith(".diff")).sort()) {
    const diff = readFileSync(new URL(file, directory), "utf8");
    const expected = (diff.match(/^# expect:(.*)$/m)?.[1] ?? "").split(",").map(s => s.trim()).filter(Boolean).sort();
    console.error(`Evaluating ${file}`);
    const report = await check({ config, hunks: parseHunks(diff), client });
    if (!report.complete) throw new Error("Synthetic fixture coverage incomplete");
    const actual = [...new Set(report.findings.map(f => f.rule))].sort();
    const passed = JSON.stringify(expected) === JSON.stringify(actual);
    if (!passed) mismatches++;
    console.log(JSON.stringify({ file, expected, actual, passed, models: report.stats.modelIds }));
  }
  console.log(JSON.stringify({ syntheticDataOnly: true, zeroDataRetention, mismatches }));
  process.exitCode = mismatches ? 1 : 0;
} catch (error) {
  const failure = error as { name?: string; statusCode?: number; lastError?: { name?: string; statusCode?: number } };
  console.error("Synthetic preset evaluation failed", JSON.stringify({ name: failure.name, status: failure.statusCode, last: failure.lastError?.name, lastStatus: failure.lastError?.statusCode }));
  process.exitCode = 2;
}
