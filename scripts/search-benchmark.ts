/** Fixed-window retrieval pilot. Only public, pinned Git objects are sent; repository code is never executed. */
class BenchmarkError extends Error {}

export interface EvidenceRange { file: string; startLine: number; endLine: number }
export interface ScoredRange extends EvidenceRange { score: number }

export function measureSearch(result: { complete: boolean; matches: ScoredRange[] }, targets: EvidenceRange[], threshold: number) {
  if (!result.complete) throw new BenchmarkError("Incomplete searches cannot produce benchmark metrics");
  const matches = result.matches.filter(match => match.score >= threshold);
  const covered = new Map<string, Set<number>>();
  for (const match of matches) {
    const lines = covered.get(match.file) ?? new Set<number>();
    for (let line = match.startLine; line <= match.endLine; line++) lines.add(line);
    covered.set(match.file, lines);
  }
  const recovered = targets.filter(target => {
    for (let line = target.startLine; line <= target.endLine; line++) if (!covered.get(target.file)?.has(line)) return false;
    return true;
  }).length;
  return { targets: targets.length, recovered, evidenceRecall: targets.length ? recovered / targets.length : null,
    returnedChunks: matches.length, uniqueLines: [...covered.values()].reduce((sum, lines) => sum + lines.size, 0) };
}

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { clientFromEnv, find, inScope, parseConfig, repoHunks, type FindResult, type Hunk, type RepoReader } from "../packages/core/src/index.js";
import { gitRepo } from "../packages/cli/src/local.js";
import { VERSION } from "../packages/cli/src/version.js";

interface Repository { id: string; url: string; tag: string; commit: string; license: string; split: string }
interface BenchmarkCase { id: string; repository: string; query: string; kind: string; targets: (EvidenceRange & { sha256: string })[]; rationale: string; lexicalTerms: string[] }
interface Variant { id: string; chunkLines: number; overlapLines: number }
interface Corpus { version: number; annotation: string; scope: { include: string[]; ignore: string[] }; repositories: Repository[]; cases: BenchmarkCase[]; variants: Variant[]; thresholds: number[] }
interface Artifact {
  identity: string; caseId: string; repository: string; commit: string; variant: Variant;
  query: string; provider: string; requestedModel: string; zeroDataRetention: boolean;
  startedAt: string; elapsedMs: number; complete: boolean; notices: string[];
  stats: FindResult["stats"]; matches: (ScoredRange & { sourceHash: string })[];
}
type ExpectedCase = Pick<Artifact, "identity" | "caseId" | "repository" | "commit" | "query" | "variant" | "provider" | "requestedModel" | "zeroDataRetention"> & { hunks: Hunk[] };

/** Report a saved evaluation only after checking it against the current query and complete source windows. */
export function measureBenchmarkCase(artifact: Artifact, expected: ExpectedCase, targets: EvidenceRange[], thresholds: number[]) {
  const invalid = () => { throw new BenchmarkError("Invalid benchmark artifact: identity, coverage or scores do not match the planned evaluation"); };
  for (const key of ["identity", "caseId", "repository", "commit", "query", "provider", "requestedModel", "zeroDataRetention"] as const) {
    if (artifact[key] !== expected[key]) invalid();
  }
  for (const key of ["id", "chunkLines", "overlapLines"] as const) if (artifact.variant?.[key] !== expected.variant[key]) invalid();
  if (artifact.complete !== true || !Array.isArray(artifact.notices) || artifact.notices.length ||
      !Number.isFinite(artifact.elapsedMs) || artifact.elapsedMs < 0 || !Number.isFinite(Date.parse(artifact.startedAt))) invalid();
  const stats = artifact.stats;
  if (!stats || stats.chunks !== expected.hunks.length || stats.scored !== expected.hunks.length || stats.requests !== expected.hunks.length ||
      !Number.isSafeInteger(stats.inputTokens) || stats.inputTokens < 0 || !Array.isArray(stats.modelIds) || !stats.modelIds.every(id => typeof id === "string")) invalid();
  const key = (file: string, start: number, end: number) => JSON.stringify([file, start, end]);
  const remaining = new Map(expected.hunks.map(hunk => [key(hunk.file, hunk.newStart, hunk.newStart + hunk.newLines - 1), hash(hunk.text)]));
  if (!Array.isArray(artifact.matches) || artifact.matches.length !== expected.hunks.length || remaining.size !== expected.hunks.length) invalid();
  for (const match of artifact.matches) {
    const id = key(match.file, match.startLine, match.endLine);
    if (!Number.isFinite(match.score) || match.score < 0 || match.score > 1 || !remaining.has(id) || remaining.get(id) !== match.sourceHash) invalid();
    remaining.delete(id);
  }
  if (remaining.size) invalid();
  return thresholds.map(threshold => ({ threshold, ...measureSearch(artifact, targets, threshold) }));
}
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "benchmarks/search/corpus.json");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const command = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32_000_000 });
function save(path: string, value: unknown) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
  renameSync(temporary, path);
}

function checkout(cache: string, repo: Repository) {
  if (!/^[a-z0-9-]+$/.test(repo.id) || !/^[a-f0-9]{40}$/.test(repo.commit) || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/.test(repo.url)) throw new BenchmarkError("Invalid public repository identity");
  mkdirSync(cache, { recursive: true });
  const path = join(cache, repo.id);
  if (!existsSync(path)) command(cache, ["clone", "--no-checkout", "--depth", "1", "--branch", repo.tag, "--", repo.url, path]);
  if (command(path, ["remote", "get-url", "origin"]).trim() !== repo.url) throw new BenchmarkError("Cached repository has a different origin");
  try { command(path, ["cat-file", "-e", `${repo.commit}^{commit}`]); }
  catch { command(path, ["fetch", "--depth", "1", "origin", repo.commit]); }
  return path;
}

async function snapshot(path: string, commit: string): Promise<RepoReader> {
  const reader = gitRepo(path, commit);
  const cache = new Map<string, Promise<string | null>>();
  return { ...reader, read(file) {
    if (!cache.has(file)) cache.set(file, reader.read(file));
    return cache.get(file)!;
  } };
}

function renderSummary(corpus: Corpus, artifacts: Artifact[], lexical: Record<string, ScoredRange[]>) {
  const rows = artifacts.flatMap(artifact => {
    const item = corpus.cases.find(item => item.id === artifact.caseId)!;
    return corpus.thresholds.map(threshold => ({ caseId: item.id, repository: item.repository, kind: item.kind, variant: artifact.variant.id, threshold,
      ...measureSearch(artifact, item.targets, threshold), elapsedMs: artifact.elapsedMs, inputTokens: artifact.stats.inputTokens, requests: artifact.stats.requests }));
  });
  const lexicalRows = corpus.cases.map(item => ({ caseId: item.id, kind: item.kind, ...measureSearch({ complete: true, matches: lexical[item.id]! }, item.targets, 0) }));
  const aggregate = corpus.variants.flatMap(variant => corpus.thresholds.map(threshold => {
    const selected = rows.filter(row => row.variant === variant.id && row.threshold === threshold);
    const positives = selected.filter(row => row.kind === "positive");
    const targets = positives.reduce((sum, row) => sum + row.targets, 0);
    const recovered = positives.reduce((sum, row) => sum + row.recovered, 0);
    return { variant: variant.id, threshold, targets, recovered, evidenceRecall: targets ? recovered / targets : null,
      fullyRecoveredCases: positives.filter(row => row.recovered === row.targets).length,
      positiveCases: positives.length,
      averageUniqueLines: selected.reduce((sum, row) => sum + row.uniqueLines, 0) / selected.length,
      controlChunks: selected.filter(row => row.kind !== "positive").reduce((sum, row) => sum + row.returnedChunks, 0) };
  }));
  return { annotation: corpus.annotation, aggregate, rows, lexicalRows };
}

function renderMarkdown(summary: ReturnType<typeof renderSummary>, artifacts: Artifact[], corpus: Corpus) {
  const lines = ["# Fixed-window search pilot", "", `Generated ${new Date().toISOString()}. Hunch ${VERSION}.`, "",
    "Sparse, agent-authored source targets were frozen before model evaluation. Evidence recall is the fraction of annotated spans whose every line occurs in returned candidates. It is not exhaustive semantic recall or precision. Unsupported-query control matches require adjudication; they are not automatically false positives.", "",
    "| Variant | Threshold | Evidence recovered | Fully recovered positive cases | Mean unique source lines returned | Control chunks |",
    "| --- | ---: | ---: | ---: | ---: | ---: |"];
  for (const row of summary.aggregate) lines.push(`| ${row.variant} | ${row.threshold} | ${row.recovered}/${row.targets} | ${row.fullyRecoveredCases}/${row.positiveCases} | ${row.averageUniqueLines.toFixed(0)} | ${row.controlChunks} |`);
  lines.push("", "## Measured usage", "", "| Variant | Logical requests | Reported input tokens | Summed evaluation seconds |", "| --- | ---: | ---: | ---: |");
  for (const variant of corpus.variants) {
    const selected = artifacts.filter(artifact => artifact.variant.id === variant.id);
    lines.push(`| ${variant.id} | ${selected.reduce((s, a) => s + a.stats.requests, 0)} | ${selected.reduce((s, a) => s + a.stats.inputTokens, 0)} | ${(selected.reduce((s, a) => s + a.elapsedMs, 0) / 1000).toFixed(1)} |`);
  }
  lines.push("", "Provider retries may consume additional time and tokens not exposed by the adapter. Timings exclude cloning and annotation. Gateway model names are unpinned; this does not establish reproducibility across future model revisions.", "",
    "## Fixed lexical probe", "", "Literal case-insensitive OR terms were frozen with the queries. Matching lines receive 20 lines of context either side. This is a diagnostic baseline, not an agent using iterative grep and file reads, and cannot establish superiority to grep.", "",
    "| Case | Evidence recovered | Unique lines returned |", "| --- | ---: | ---: |");
  for (const row of summary.lexicalRows) lines.push(`| ${row.caseId} | ${row.targets ? `${row.recovered}/${row.targets}` : "control"} | ${row.uniqueLines} |`);
  lines.push("", "## Sources", "");
  for (const repo of corpus.repositories) lines.push(`- [${repo.id} ${repo.tag}](${repo.url.replace(/\.git$/, "")}/tree/${repo.commit}) — ${repo.commit}, ${repo.license}, ${repo.split}.`);
  lines.push("", "Machine-readable per-case results are in summary.json; raw scores and chunk hashes are in the individual JSON artifacts. Unlabelled matches remain unjudged. This pilot does not measure downstream coding-task success, calibrate probabilities, or justify adaptive pruning.", "");
  return lines.join("\n");
}

async function main() {
  const { values } = parseArgs({ options: { live: { type: "boolean", default: false }, output: { type: "string", default: "docs/benchmarks/fixed-windows-2026-09-19" }, cache: { type: "string", default: join(tmpdir(), "hunch-search-benchmark-repos") }, concurrency: { type: "string", default: "8" }, provider: { type: "string", default: "gateway" } }, strict: true });
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new BenchmarkError("Concurrency must be 1 to 32");
  if (values.provider !== "gateway" && values.provider !== "typesafe") throw new BenchmarkError("Provider must be gateway or typesafe");
  const provider = values.provider;
  const source = readFileSync(MANIFEST, "utf8");
  const corpus: Corpus = JSON.parse(source);
  const implementationFiles = ["bun.lock", "package.json", "packages/core/package.json", "packages/cli/package.json",
    ...["packages/core/src", "packages/cli/src"].flatMap(directory => readdirSync(join(ROOT, directory), { recursive: true, encoding: "utf8" })
      .filter(file => file.endsWith(".ts")).map(file => `${directory}/${file}`))].sort();
  const implementationHash = hash(JSON.stringify(implementationFiles.map(file => [file, hash(readFileSync(join(ROOT, file), "utf8"))])));
  const runnerHash = hash(readFileSync(fileURLToPath(import.meta.url), "utf8"));
  const identity = hash(JSON.stringify({ runnerHash, corpusHash: hash(source), implementationHash, provider, concurrency, model: "jev-1.13.0", zeroDataRetention: false }));
  const output = resolve(ROOT, values.output);
  if (existsSync(output)) for (const file of readdirSync(output).filter(file => file.endsWith(".json"))) {
    const previous = JSON.parse(readFileSync(join(output, file), "utf8"));
    if (previous.identity !== identity) throw new BenchmarkError("Existing artifacts belong to a different corpus, implementation or run configuration; choose a new output directory");
  }
  mkdirSync(output, { recursive: true });
  const plan: { repository: string; commit: string; files: number; variants: (Variant & { chunks: number; requests: number })[] }[] = [];
  const inputs = new Map<string, Hunk[]>();
  const lexical: Record<string, ScoredRange[]> = {};
  const config = parseConfig({ ...corpus.scope, agentsMd: false }, "benchmark");

  // Finish scope and label validation for the entire corpus before sending any model request.
  for (const repo of corpus.repositories) {
    console.error(`Validating ${repo.id} at ${repo.commit}`);
    const reader = await snapshot(checkout(values.cache, repo), repo.commit);
    const cases = corpus.cases.filter(item => item.repository === repo.id);
    const files = (await reader.files()).filter(inScope(config));
    for (const item of cases) {
      if (!/^[a-z0-9-]+$/.test(item.id)) throw new BenchmarkError("Invalid case id");
      for (const target of item.targets) {
        const text = await reader.read(target.file);
        if (text == null || !files.includes(target.file)) throw new BenchmarkError(`Missing target: ${item.id}`);
        if (hash(text.replace(/\n$/, "").split("\n").slice(target.startLine - 1, target.endLine).join("\n")) !== target.sha256) throw new BenchmarkError(`Evidence mismatch: ${item.id}`);
      }
      lexical[item.id] = [];
      for (const file of files) {
        const text = await reader.read(file);
        if (text == null || text.includes("\0") || text.length > 1_000_000) continue;
        const lines = text.replace(/\n$/, "").split("\n");
        for (const [index, line] of lines.entries()) if (item.lexicalTerms.some(term => line.toLowerCase().includes(term.toLowerCase()))) {
          lexical[item.id]!.push({ file, startLine: Math.max(1, index + 1 - 20), endLine: Math.min(lines.length, index + 1 + 20), score: 1 });
        }
      }
    }
    const variants = [];
    for (const variant of corpus.variants) {
      const { hunks, skipped } = await repoHunks(reader, config, [], variant);
      if (skipped.length) throw new BenchmarkError(`Corpus has undeclared skipped files in ${repo.id}: ${skipped.join(", ")}`);
      inputs.set(`${repo.id}/${variant.id}`, hunks);
      variants.push({ ...variant, chunks: hunks.length, requests: hunks.length * cases.length });
    }
    plan.push({ repository: repo.id, commit: repo.commit, files: files.length, variants });
  }
  save(join(output, "plan.json"), { identity, runnerHash, implementationHash, implementationFiles, corpusHash: hash(source), provider, zeroDataRetention: false, concurrency, annotation: corpus.annotation, plan });
  writeFileSync(join(output, "runner.ts.txt"), readFileSync(fileURLToPath(import.meta.url), "utf8"));
  console.log(JSON.stringify({ mode: values.live ? "live" : "plan", identity, cases: corpus.cases.length, requests: plan.flatMap(repo => repo.variants).reduce((sum, variant) => sum + variant.requests, 0), plan }, null, 2));
  if (!values.live) return;
  const client = clientFromEnv({ provider, zeroDataRetention: false });
  const artifacts: Artifact[] = [];
  // Interleave window variants across cases so one variant does not exclusively see one time period.
  for (const [index, item] of corpus.cases.entries()) {
    const variants = [...corpus.variants.slice(index % corpus.variants.length), ...corpus.variants.slice(0, index % corpus.variants.length)];
    for (const variant of variants) {
      const path = join(output, `${item.id}--${variant.id}.json`);
      const hunks = inputs.get(`${item.repository}/${variant.id}`)!;
      const expected: ExpectedCase = { identity, caseId: item.id, repository: item.repository, commit: corpus.repositories.find(repo => repo.id === item.repository)!.commit,
        query: item.query, variant, provider, requestedModel: "jev-1.13.0", zeroDataRetention: false, hunks };
      if (existsSync(path)) {
        const previous: Artifact = JSON.parse(readFileSync(path, "utf8"));
        if (previous.identity !== identity) throw new BenchmarkError("Existing artifacts belong to a different corpus, implementation or run configuration; choose a new output directory");
        if (previous.complete) { measureBenchmarkCase(previous, expected, item.targets, corpus.thresholds); artifacts.push(previous); continue; }
        throw new BenchmarkError(`Incomplete artifact retained at ${path}; use a new output directory to retry`);
      }
      const sourceHashes = new Map(hunks.map(hunk => [`${hunk.file}:${hunk.newStart}:${hunk.newLines}`, hash(hunk.text)]));
      const startedAt = new Date().toISOString();
      const start = performance.now();
      const result = await find({ task: item.query, mode: "condition", hunks, model: "jev-1.13.0", client, minScore: 0, perFacet: 0,
        budget: { concurrency, maxRequests: hunks.length, timeoutSeconds: 3600 },
        onProgress(done, total) { if (done % 50 === 0 || done === total) console.error(`${item.id}/${variant.id}: ${done}/${total}`); },
      });
      const artifact: Artifact = { identity, caseId: item.id, repository: item.repository, commit: corpus.repositories.find(repo => repo.id === item.repository)!.commit, variant,
        query: item.query, provider, requestedModel: "jev-1.13.0", zeroDataRetention: false, startedAt, elapsedMs: performance.now() - start,
        complete: result.complete, notices: result.notices, stats: result.stats,
        matches: result.matches.map(match => ({ file: match.file, startLine: match.startLine, endLine: match.endLine, score: match.score,
          sourceHash: sourceHashes.get(`${match.file}:${match.startLine}:${match.endLine - match.startLine + 1}`)! })),
      };
      save(path, artifact);
      if (!result.complete) throw new BenchmarkError(`Incomplete evaluation: ${item.id}/${variant.id}. Artifact preserved; no aggregate success metrics emitted.`);
      measureBenchmarkCase(artifact, expected, item.targets, corpus.thresholds);
      artifacts.push(artifact);
    }
  }
  const summary = renderSummary(corpus, artifacts, lexical);
  save(join(output, "summary.json"), { identity, runnerHash, implementationHash, corpusHash: hash(source), ...summary });
  writeFileSync(join(output, "README.md"), renderMarkdown(summary, artifacts, corpus));
  console.log(`Completed ${artifacts.length} evaluations: ${output}`);
}

if (import.meta.main) main().catch(error => {
  // Provider/library exceptions can contain credentials or response bodies.
  console.error(error instanceof BenchmarkError ? error.message : "Benchmark stopped. Check repository access and provider availability. Raw error details are not printed.");
  process.exitCode = 2;
});
