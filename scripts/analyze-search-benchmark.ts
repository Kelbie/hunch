/** Offline interpretation of the frozen pilot; never calls a model or changes raw artifacts. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { parseConfig, repoHunks } from "../packages/core/src/index.js";
import { gitRepo } from "../packages/cli/src/local.js";
import { measureBenchmarkCase } from "./search-benchmark.js";
import corpus from "../benchmarks/search/corpus.json";

const { values } = parseArgs({ options: {
  output: { type: "string", default: "docs/benchmarks/fixed-windows-2026-09-19" },
  cache: { type: "string", default: join(tmpdir(), "hunch-search-benchmark-repos") },
}, strict: true });
const root = resolve(import.meta.dir, "..");
const output = resolve(root, values.output);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const read = (file: string) => JSON.parse(readFileSync(join(output, file), "utf8"));
const plan = read("plan.json");
if (sha(readFileSync(join(output, "runner.ts.txt"), "utf8")) !== plan.runnerHash ||
    sha(readFileSync(join(root, "benchmarks/search/corpus.json"), "utf8")) !== plan.corpusHash) throw new Error("Frozen provenance does not match");
const implementationFiles: string[] = plan.implementationFiles ?? ["find", "full", "context", "jev"].map(name => `packages/core/src/${name}.ts`);
if (!implementationFiles.every(file => /^(packages\/(core|cli)\/src\/[\w/-]+\.ts|(?:packages\/(?:core|cli)\/)?package\.json|bun\.lock)$/.test(file))) throw new Error("Invalid implementation paths");
const implementationSources = implementationFiles.map(file => ({ file, source: readFileSync(existsSync(join(output, "engine", `${file}.txt`)) ? join(output, "engine", `${file}.txt`) : join(root, file), "utf8") }));
const implementationHash = plan.implementationFiles
  ? sha(JSON.stringify(implementationSources.map(item => [item.file, sha(item.source)])))
  : sha(implementationSources.map(item => item.source).join("\n"));
if (implementationHash !== plan.implementationHash) throw new Error("Engine implementation differs from the frozen run");

// Review identified these wording defects after evaluation began. Preserve the original corpus.
const exclusions = {
  "flask-bad-signature": "The code returns an empty session object; it does not replace the browser cookie.",
  "chi-deadline": "The middleware attempts to write a timeout status after the handler returns; it cannot guarantee delivery at the deadline.",
};
const rows: { caseId: string; repository: string; split: string; kind: string; variant: string; threshold: number; targets: number; recovered: number; uniqueLines: number; returnedChunks: number }[] = [];
const usage: { variant: string; requests: number; inputTokens: number; elapsedMs: number }[] = [];
let verifiedArtifacts = 0;
const config = parseConfig({ ...corpus.scope, agentsMd: false }, "benchmark");
for (const repo of corpus.repositories) {
  const reader = gitRepo(join(values.cache, repo.id), repo.commit);
  for (const item of corpus.cases.filter(item => item.repository === repo.id)) for (const target of item.targets) {
    const source = await reader.read(target.file);
    if (source === null || sha(source.replace(/\n$/, "").split("\n").slice(target.startLine - 1, target.endLine).join("\n")) !== target.sha256) throw new Error("Evidence hash mismatch");
  }
  for (const variant of corpus.variants) {
    const { hunks, skipped } = await repoHunks(reader, config, [], variant);
    if (skipped.length) throw new Error("Incomplete reconstructed scope");
    for (const item of corpus.cases.filter(item => item.repository === repo.id)) {
      const artifact = read(`${item.id}--${variant.id}.json`);
      const measures = measureBenchmarkCase(artifact, { identity: plan.identity, caseId: item.id, repository: repo.id, commit: repo.commit,
        query: item.query, variant, provider: plan.provider, requestedModel: "jev-1.13.0", zeroDataRetention: false, hunks }, item.targets, corpus.thresholds);
      verifiedArtifacts++;
      usage.push({ variant: variant.id, requests: artifact.stats.requests, inputTokens: artifact.stats.inputTokens, elapsedMs: artifact.elapsedMs });
      for (const measure of measures) rows.push({ caseId: item.id, repository: repo.id, split: repo.split, kind: item.kind, variant: variant.id, ...measure });
    }
  }
}
const aggregate = ["all-original", "all-reviewed", "evaluation-reviewed", ...corpus.repositories.map(repo => repo.id)].flatMap(group =>
  corpus.variants.flatMap(variant => corpus.thresholds.map(threshold => {
    const selected = rows.filter(row => row.variant === variant.id && row.threshold === threshold &&
      (group === "all-original" || !Object.hasOwn(exclusions, row.caseId)) &&
      (group.startsWith("all-") || (group === "evaluation-reviewed" ? row.split === "evaluation" : row.repository === group)));
    const positives = selected.filter(row => row.kind === "positive");
    return { group, variant: variant.id, threshold,
      recovered: positives.reduce((sum, row) => sum + row.recovered, 0), targets: positives.reduce((sum, row) => sum + row.targets, 0),
      casesRecovered: positives.filter(row => row.recovered === row.targets).length, positiveCases: positives.length,
      meanPositiveLines: positives.reduce((sum, row) => sum + row.uniqueLines, 0) / positives.length,
      controlChunks: selected.filter(row => row.kind !== "positive").reduce((sum, row) => sum + row.returnedChunks, 0),
      misses: positives.filter(row => row.recovered < row.targets).map(row => row.caseId),
    };
  })));
const attemptsDirectory = join(output, "attempts");
const incompleteAttempts = existsSync(attemptsDirectory) ? readdirSync(attemptsDirectory).filter(file => file.endsWith(".json")).map(file => {
  const artifact = read(`attempts/${file}`);
  const item = corpus.cases.find(item => item.id === artifact.caseId);
  const repo = corpus.repositories.find(repo => repo.id === item?.repository);
  const variant = corpus.variants.find(variant => variant.id === artifact.variant?.id);
  const plannedChunks = plan.plan.find((entry: { repository: string }) => entry.repository === repo?.id)?.variants.find((entry: { id: string }) => entry.id === variant?.id)?.chunks;
  if (artifact.identity !== plan.identity || artifact.complete !== false || !Number.isSafeInteger(artifact.stats.requests) ||
      !Number.isSafeInteger(artifact.stats.inputTokens) || artifact.stats.requests < 0 || artifact.stats.inputTokens < 0 ||
      !item || !repo || !variant || artifact.query !== item.query || artifact.repository !== repo.id || artifact.commit !== repo.commit ||
      artifact.provider !== plan.provider || artifact.requestedModel !== "jev-1.13.0" || artifact.zeroDataRetention !== false ||
      artifact.variant.chunkLines !== variant.chunkLines || artifact.variant.overlapLines !== variant.overlapLines ||
      !Number.isFinite(artifact.elapsedMs) || artifact.elapsedMs < 0 || !Number.isSafeInteger(artifact.stats.scored) ||
      artifact.stats.scored < 0 || artifact.stats.scored > artifact.stats.requests || !Number.isSafeInteger(plannedChunks) || artifact.stats.requests > plannedChunks) throw new Error("Invalid preserved attempt");
  return { file, caseId: artifact.caseId, variant: artifact.variant.id, requests: artifact.stats.requests,
    inputTokens: artifact.stats.inputTokens, elapsedMs: artifact.elapsedMs, scored: artifact.stats.scored };
}) : [];
const allUsage = [...usage, ...incompleteAttempts];
const totals = { requests: allUsage.reduce((sum, item) => sum + item.requests, 0), inputTokens: allUsage.reduce((sum, item) => sum + item.inputTokens, 0),
  elapsedSeconds: allUsage.reduce((sum, item) => sum + item.elapsedMs, 0) / 1000 };
for (const item of implementationSources) {
  const path = join(output, "engine", `${item.file}.txt`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, item.source);
}
const result = { identity: plan.identity, generatedAt: new Date().toISOString(), analysisScriptHash: sha(readFileSync(import.meta.path, "utf8")),
  verifiedImplementationHash: implementationHash, implementationSources: implementationSources.map(item => ({ file: item.file, sha256: sha(item.source) })),
  verifiedArtifacts, exclusions, aggregate, usage, incompleteAttempts, totals, rows };
writeFileSync(join(output, "analysis.json"), JSON.stringify(result, null, 2) + "\n");
const lines = ["# Reviewed fixed-window results", "", "This offline report reconstructs every source window from the pinned commits and validates every saved evaluation's identity, coverage, scores and source hashes. The original corpus and raw results remain unchanged.", "",
  "Two queries were excluded from reviewed aggregates after source review identified ambiguous wording:", "",
  ...Object.entries(exclusions).map(([id, reason]) => `- **${id}:** ${reason}`), "",
  "P-retry is development data; Flask and chi are evaluation data. All annotations are sparse and agent-authored. These exclusions were decided after evaluation began, so both original and reviewed results are included for sensitivity analysis.", ""];
for (const group of [...new Set(aggregate.map(row => row.group))]) {
  lines.push(`## ${group}`, "", "| Window | Threshold | Evidence recovered | Full cases | Mean positive-query source lines | Control chunks |", "| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const row of aggregate.filter(row => row.group === group)) lines.push(`| ${row.variant} | ${row.threshold} | ${row.recovered}/${row.targets} | ${row.casesRecovered}/${row.positiveCases} | ${row.meanPositiveLines.toFixed(0)} | ${row.controlChunks} |`);
  lines.push("");
}
lines.push("## Attempts and usage", "", `${incompleteAttempts.length} incomplete case/window attempt(s) were preserved under attempts/. Only complete replacement evaluations enter recall tables. Including preserved attempts: ${totals.requests.toLocaleString("en-US")} logical requests, ${totals.inputTokens.toLocaleString("en-US")} reported input tokens, and ${totals.elapsedSeconds.toFixed(1)} summed evaluation seconds. Internal provider retries can consume additional unreported tokens. Diagnostic smoke calls are outside these artifacts.`, "",
  "Incomplete case/windows were rerun in full using the byte-identical frozen runner (copied beside the maintained script so its imports resolve), same source, query, provider and concurrency. Completed windows were reused unchanged; retries were triggered by transport/coverage failure, never by model scores. The provider's model identifier is unpinned. Timing includes variable retry delays and should not establish a chunk-size latency advantage.", "",
  "## Interpretation limits", "", "Evidence recall means recovery of annotated lines, not all relevant behavior. The chi constant-time target covers password comparison, not constant-time authentication. The backlog annotation omits the outer token acquisition needed to verify the whole behavior. Control candidates remain unjudged. Returned lines are a workload proxy, not measured agent tokens or coding success.", "",
  "No default should be selected from this small pilot alone. The thresholds were frozen before evaluation, but candidate workloads differ. A follow-up needs independent labels and a predeclared equal reading budget. This study does not establish superiority to agentic grep or justify pruning low-scoring parent windows.", "",
  `Verified ${verifiedArtifacts} complete case/window artifacts. The exact original runner is preserved in runner.ts.txt; its SHA-256 matches plan.json. The engine source hash also matches the original plan, and those source files are preserved under engine/. The maintained runner subsequently received stricter resume checks, so reruns require a fresh output directory.`, "",
  "Reproduce this offline validation and these tables from the repository root after fetching the pinned corpus:", "", "```sh", `bun scripts/analyze-search-benchmark.ts --output ${values.output}`, "```", "",
  "[Original aggregate and measured usage](README.md) · [Machine-readable reviewed results](analysis.json) · [Benchmark method](../../../benchmarks/search/README.md)", "");
writeFileSync(join(output, "analysis.md"), lines.join("\n"));
console.log(`Verified ${verifiedArtifacts} artifacts and wrote reviewed tables to ${output}`);
