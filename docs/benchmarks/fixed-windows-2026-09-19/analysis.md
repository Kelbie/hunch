# Reviewed fixed-window results

This offline report reconstructs every source window from the pinned commits and validates every saved evaluation's identity, coverage, scores and source hashes. The original corpus and raw results remain unchanged.

Two queries were excluded from reviewed aggregates after source review identified ambiguous wording:

- **flask-bad-signature:** The code returns an empty session object; it does not replace the browser cookie.
- **chi-deadline:** The middleware attempts to write a timeout status after the handler returns; it cannot guarantee delivery at the deadline.

P-retry is development data; Flask and chi are evaluation data. All annotations are sparse and agent-authored. These exclusions were decided after evaluation began, so both original and reviewed results are included for sensitivity analysis.

## all-original

| Window | Threshold | Evidence recovered | Full cases | Mean positive-query source lines | Control chunks |
| --- | ---: | ---: | ---: | ---: | ---: |
| lines-50 | 0.2 | 16/16 | 12/12 | 276 | 732 |
| lines-50 | 0.35 | 16/16 | 12/12 | 166 | 28 |
| lines-50 | 0.5 | 13/16 | 9/12 | 109 | 2 |
| lines-50 | 0.7 | 11/16 | 8/12 | 63 | 0 |
| lines-150 | 0.2 | 16/16 | 12/12 | 495 | 313 |
| lines-150 | 0.35 | 16/16 | 12/12 | 294 | 12 |
| lines-150 | 0.5 | 16/16 | 12/12 | 250 | 1 |
| lines-150 | 0.7 | 14/16 | 10/12 | 135 | 0 |
| lines-300 | 0.2 | 16/16 | 12/12 | 681 | 220 |
| lines-300 | 0.35 | 16/16 | 12/12 | 412 | 7 |
| lines-300 | 0.5 | 16/16 | 12/12 | 370 | 1 |
| lines-300 | 0.7 | 13/16 | 9/12 | 216 | 0 |
| lines-150-overlap-30 | 0.2 | 16/16 | 12/12 | 596 | 347 |
| lines-150-overlap-30 | 0.35 | 16/16 | 12/12 | 324 | 14 |
| lines-150-overlap-30 | 0.5 | 15/16 | 11/12 | 249 | 2 |
| lines-150-overlap-30 | 0.7 | 14/16 | 10/12 | 165 | 0 |

## all-reviewed

| Window | Threshold | Evidence recovered | Full cases | Mean positive-query source lines | Control chunks |
| --- | ---: | ---: | ---: | ---: | ---: |
| lines-50 | 0.2 | 14/14 | 10/10 | 305 | 732 |
| lines-50 | 0.35 | 14/14 | 10/10 | 173 | 28 |
| lines-50 | 0.5 | 11/14 | 7/10 | 112 | 2 |
| lines-50 | 0.7 | 10/14 | 7/10 | 62 | 0 |
| lines-150 | 0.2 | 14/14 | 10/10 | 539 | 313 |
| lines-150 | 0.35 | 14/14 | 10/10 | 312 | 12 |
| lines-150 | 0.5 | 14/14 | 10/10 | 260 | 1 |
| lines-150 | 0.7 | 13/14 | 9/10 | 157 | 0 |
| lines-300 | 0.2 | 14/14 | 10/10 | 763 | 220 |
| lines-300 | 0.35 | 14/14 | 10/10 | 441 | 7 |
| lines-300 | 0.5 | 14/14 | 10/10 | 420 | 1 |
| lines-300 | 0.7 | 12/14 | 8/10 | 254 | 0 |
| lines-150-overlap-30 | 0.2 | 14/14 | 10/10 | 659 | 347 |
| lines-150-overlap-30 | 0.35 | 14/14 | 10/10 | 348 | 14 |
| lines-150-overlap-30 | 0.5 | 13/14 | 9/10 | 258 | 2 |
| lines-150-overlap-30 | 0.7 | 13/14 | 9/10 | 184 | 0 |

## evaluation-reviewed

| Window | Threshold | Evidence recovered | Full cases | Mean positive-query source lines | Control chunks |
| --- | ---: | ---: | ---: | ---: | ---: |
| lines-50 | 0.2 | 8/8 | 6/6 | 242 | 729 |
| lines-50 | 0.35 | 8/8 | 6/6 | 119 | 27 |
| lines-50 | 0.5 | 7/8 | 5/6 | 80 | 2 |
| lines-50 | 0.7 | 7/8 | 5/6 | 44 | 0 |
| lines-150 | 0.2 | 8/8 | 6/6 | 526 | 313 |
| lines-150 | 0.35 | 8/8 | 6/6 | 279 | 12 |
| lines-150 | 0.5 | 8/8 | 6/6 | 214 | 1 |
| lines-150 | 0.7 | 7/8 | 5/6 | 123 | 0 |
| lines-300 | 0.2 | 8/8 | 6/6 | 882 | 219 |
| lines-300 | 0.35 | 8/8 | 6/6 | 441 | 7 |
| lines-300 | 0.5 | 8/8 | 6/6 | 406 | 1 |
| lines-300 | 0.7 | 6/8 | 4/6 | 160 | 0 |
| lines-150-overlap-30 | 0.2 | 8/8 | 6/6 | 715 | 345 |
| lines-150-overlap-30 | 0.35 | 8/8 | 6/6 | 315 | 14 |
| lines-150-overlap-30 | 0.5 | 7/8 | 5/6 | 215 | 2 |
| lines-150-overlap-30 | 0.7 | 7/8 | 5/6 | 140 | 0 |

## p-retry

| Window | Threshold | Evidence recovered | Full cases | Mean positive-query source lines | Control chunks |
| --- | ---: | ---: | ---: | ---: | ---: |
| lines-50 | 0.2 | 6/6 | 4/4 | 399 | 3 |
| lines-50 | 0.35 | 6/6 | 4/4 | 253 | 1 |
| lines-50 | 0.5 | 4/6 | 2/4 | 160 | 0 |
| lines-50 | 0.7 | 3/6 | 2/4 | 89 | 0 |
| lines-150 | 0.2 | 6/6 | 4/4 | 560 | 0 |
| lines-150 | 0.35 | 6/6 | 4/4 | 362 | 0 |
| lines-150 | 0.5 | 6/6 | 4/4 | 329 | 0 |
| lines-150 | 0.7 | 6/6 | 4/4 | 208 | 0 |
| lines-300 | 0.2 | 6/6 | 4/4 | 585 | 1 |
| lines-300 | 0.35 | 6/6 | 4/4 | 441 | 0 |
| lines-300 | 0.5 | 6/6 | 4/4 | 441 | 0 |
| lines-300 | 0.7 | 6/6 | 4/4 | 395 | 0 |
| lines-150-overlap-30 | 0.2 | 6/6 | 4/4 | 577 | 2 |
| lines-150-overlap-30 | 0.35 | 6/6 | 4/4 | 397 | 0 |
| lines-150-overlap-30 | 0.5 | 6/6 | 4/4 | 323 | 0 |
| lines-150-overlap-30 | 0.7 | 6/6 | 4/4 | 250 | 0 |

## flask

| Window | Threshold | Evidence recovered | Full cases | Mean positive-query source lines | Control chunks |
| --- | ---: | ---: | ---: | ---: | ---: |
| lines-50 | 0.2 | 4/4 | 3/3 | 346 | 729 |
| lines-50 | 0.35 | 4/4 | 3/3 | 170 | 27 |
| lines-50 | 0.5 | 3/4 | 2/3 | 91 | 2 |
| lines-50 | 0.7 | 3/4 | 2/3 | 44 | 0 |
| lines-150 | 0.2 | 4/4 | 3/3 | 792 | 313 |
| lines-150 | 0.35 | 4/4 | 3/3 | 401 | 12 |
| lines-150 | 0.5 | 4/4 | 3/3 | 306 | 1 |
| lines-150 | 0.7 | 3/4 | 2/3 | 146 | 0 |
| lines-300 | 0.2 | 4/4 | 3/3 | 1379 | 219 |
| lines-300 | 0.35 | 4/4 | 3/3 | 734 | 7 |
| lines-300 | 0.5 | 4/4 | 3/3 | 664 | 1 |
| lines-300 | 0.7 | 2/4 | 1/3 | 195 | 0 |
| lines-150-overlap-30 | 0.2 | 4/4 | 3/3 | 1127 | 345 |
| lines-150-overlap-30 | 0.35 | 4/4 | 3/3 | 462 | 14 |
| lines-150-overlap-30 | 0.5 | 3/4 | 2/3 | 309 | 2 |
| lines-150-overlap-30 | 0.7 | 3/4 | 2/3 | 181 | 0 |

## chi

| Window | Threshold | Evidence recovered | Full cases | Mean positive-query source lines | Control chunks |
| --- | ---: | ---: | ---: | ---: | ---: |
| lines-50 | 0.2 | 4/4 | 3/3 | 137 | 0 |
| lines-50 | 0.35 | 4/4 | 3/3 | 68 | 0 |
| lines-50 | 0.5 | 4/4 | 3/3 | 68 | 0 |
| lines-50 | 0.7 | 4/4 | 3/3 | 44 | 0 |
| lines-150 | 0.2 | 4/4 | 3/3 | 260 | 0 |
| lines-150 | 0.35 | 4/4 | 3/3 | 158 | 0 |
| lines-150 | 0.5 | 4/4 | 3/3 | 122 | 0 |
| lines-150 | 0.7 | 4/4 | 3/3 | 99 | 0 |
| lines-300 | 0.2 | 4/4 | 3/3 | 384 | 0 |
| lines-300 | 0.35 | 4/4 | 3/3 | 148 | 0 |
| lines-300 | 0.5 | 4/4 | 3/3 | 148 | 0 |
| lines-300 | 0.7 | 4/4 | 3/3 | 125 | 0 |
| lines-150-overlap-30 | 0.2 | 4/4 | 3/3 | 302 | 0 |
| lines-150-overlap-30 | 0.35 | 4/4 | 3/3 | 168 | 0 |
| lines-150-overlap-30 | 0.5 | 4/4 | 3/3 | 122 | 0 |
| lines-150-overlap-30 | 0.7 | 4/4 | 3/3 | 99 | 0 |

## Attempts and usage

1 incomplete case/window attempt(s) were preserved under attempts/. Only complete replacement evaluations enter recall tables. Including preserved attempts: 14,940 logical requests, 18,081,678 reported input tokens, and 1202.8 summed evaluation seconds. Internal provider retries can consume additional unreported tokens. Diagnostic smoke calls are outside these artifacts.

Incomplete case/windows were rerun in full using the byte-identical frozen runner (copied beside the maintained script so its imports resolve), same source, query, provider and concurrency. Completed windows were reused unchanged; retries were triggered by transport/coverage failure, never by model scores. The provider's model identifier is unpinned. Timing includes variable retry delays and should not establish a chunk-size latency advantage.

## Interpretation limits

Evidence recall means recovery of annotated lines, not all relevant behavior. The chi constant-time target covers password comparison, not constant-time authentication. The backlog annotation omits the outer token acquisition needed to verify the whole behavior. Control candidates remain unjudged. Returned lines are a workload proxy, not measured agent tokens or coding success.

No default should be selected from this small pilot alone. The thresholds were frozen before evaluation, but candidate workloads differ. A follow-up needs independent labels and a predeclared equal reading budget. This study does not establish superiority to agentic grep or justify pruning low-scoring parent windows.

Verified 60 complete case/window artifacts. The exact original runner is preserved in runner.ts.txt; its SHA-256 matches plan.json. The engine source hash also matches the original plan, and those source files are preserved under engine/. The maintained runner subsequently received stricter resume checks, so reruns require a fresh output directory.

Reproduce this offline validation and these tables from the repository root after fetching the pinned corpus:

```sh
bun scripts/analyze-search-benchmark.ts --output docs/benchmarks/fixed-windows-2026-09-19
```

[Original aggregate and measured usage](README.md) · [Machine-readable reviewed results](analysis.json) · [Benchmark method](../../../benchmarks/search/README.md)
