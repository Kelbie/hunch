# Repository-wide condition-search benchmark

This pilot compares fixed chunk sizes and overlap for **high-recall candidate discovery**. It uses
Hunch's real `find` engine and Git repository reader. It does not execute cloned code, install its
dependencies, load its Hunch configuration, or narrow candidates with search terms.

The [first live pilot's conclusions](../../docs/benchmarks/fixed-windows-2026-09-19/conclusions.md)
include reviewed results, source-reading workload, real usage and limitations.

## Run

From the Hunch repository, with Bun and Git installed:

```sh
bun scripts/search-benchmark.ts
bun scripts/search-benchmark.ts --live
```

The first command fetches and validates the pinned corpus and writes a plan without model calls.
The second evaluates every selected window against every query for that repository, saves raw
scores, and produces `docs/benchmarks/fixed-windows-2026-09-19/summary.json` and `README.md`.
Completed case/window artifacts are reused only when their manifest, engine, runner, provider and
concurrency identity agrees. A conflicting or incomplete artifact stops the run; use a new
`--output` directory rather than silently overwriting evidence. An incomplete sweep never emits
aggregate success metrics.

After a complete run, reconstruct and validate all saved source windows and produce separate
development/evaluation tables without further API calls:

```sh
bun scripts/analyze-search-benchmark.ts
```

The reviewed tables preserve the original aggregates and explicitly exclude two wording defects
identified after evaluation began (`flask-bad-signature` and `chi-deadline`). Raw scores and the
frozen corpus remain unchanged. The original runner is retained as `runner.ts.txt`, with its hash
in `plan.json`; later runner changes require a fresh output directory for new evaluations.

Options: `--cache <directory>`, `--output <directory>`, `--concurrency <1..32>` (default 8), and
`--provider gateway|typesafe` (default gateway). Gateway uses the existing account credentials or
linked-project OIDC. Direct TypeSafe uses `TYPESAFE_API_KEY`. Keys never enter corpus files or
artifacts. The benchmark explicitly disables per-request ZDR for **public source only**, matching
the existing public-data smoke workflow; production configuration is unchanged.

## Frozen design

The versioned [corpus](corpus.json) contains three exact commits: p-retry (JavaScript), Flask
(Python), and chi (Go), including license identifiers and source hashes for every evidence range.
Twelve positive questions and three unsupported-query controls were authored from source before
Jev results were inspected. These are agent-authored annotations, not human-adjudicated labels.

The declared corpus contains all Git files except Hunch's built-in artifact exclusions, PNG
presentation assets, and `.env`/`.env.*` files blocked by the safe repository reader. Tests,
examples, documentation and other eligible text remain in scope. Unreadable, binary or oversized
files outside these declared exclusions fail preparation rather than silently changing scope.

Each question is run at 50, 150 and 300 lines with no overlap, and at 150 lines with 30-line overlap.
Hunch may cut near top-level boundaries and still applies its token windowing, so these are maximum
line settings, not promises of equal token sizes. Every variant uses the same query and source
commit. Variants rotate across queries to reduce time-order confounding. All scores are retained;
thresholds 0.20, 0.35, 0.50 and 0.70 were selected before evaluation. No threshold is tuned on the
evaluation repositories or silently installed as a new product default.

## Reading the metrics

- **Annotated evidence recall:** a target is recovered only if every line in its span appears in
  returned candidate ranges, possibly across overlapping windows. This measures the evidence the
  calling agent receives, not whether one model window contained the entire dependency chain.
- **Fully recovered positive cases:** all annotated spans for a query were returned.
- **Unique returned source lines:** a reading-workload proxy, deduplicated across overlapping
  windows. It excludes report formatting and repeated import context. It is not downstream model
  token usage or measured coding-task success.
- **Control chunks:** candidates returned for unsupported-query controls. These are prompts whose
  named implementation behaves otherwise, not exhaustive negative labels for every test and doc.
  Returned chunks require adjudication; do not call this precision or a false-positive rate.
- **Requests, input tokens and elapsed time:** real adapter observations. Logical requests exclude
  internal HTTP retries; reported usage can undercount retry billing and failed calls. Timing is
  wall time inside each evaluation, excluding cloning and annotation.

There is also a fixed literal OR probe with 20 lines of context on either side of each lexical
match. Its terms were frozen with the questions. It is a diagnostic baseline, **not an autonomous
agent using iterative grep and reads**. It cannot establish that Hunch beats grep.

Raw artifacts retain the exact query, commit, window settings, scores, model IDs, source-window
hashes and implementation identity. They omit raw source, credentials and provider error bodies.
The pinned public repositories allow source reconstruction. Gateway currently exposes an unpinned
model identifier, so timestamps/model IDs do not guarantee identical answers on a later run.

## What this pilot cannot establish

The labels identify known evidence, not every relevant location. Unlabelled candidates are
unjudged. Most targets are local library behaviors, with some separated evidence spans. This small,
retrospectively selected corpus does not establish generalized vulnerability recall, probability
calibration, cross-file reasoning, end-to-end agent effectiveness, or superiority to lexical and
embedding retrievers. P-retry is marked development; Flask and chi are evaluation repositories,
but the pilot is still exploratory and lacks independent human annotation.

Inspect misses and reading workload before choosing a default. Repeat promising comparisons on
new, independently labeled repositories and at a fixed downstream reading budget. Add adaptive
split/expand refinement only if those results justify it; never prune baseline windows solely
because a larger parent scored low. See the [research record](../../docs/semantic-search-research.md).
