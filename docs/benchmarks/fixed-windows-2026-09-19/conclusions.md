# What the fixed-window pilot supports

Keep the current 150-line, zero-overlap default. This pilot does not justify adaptive pruning or
establish an optimal window size. It does identify a useful follow-up: smaller windows with a
lower cutoff can recover the same annotated evidence while returning less source for positive
queries, but they also return more candidates for unsupported queries.

The live run evaluated 15 queries across pinned p-retry, Flask and chi commits at four window
settings: **60 complete evaluations and 14,040 scored windows**. One incomplete 900-window attempt
was preserved and rerun in full, giving **14,940 logical requests and 18,081,678 reported input
tokens** across recorded attempts. Summed evaluation time was about 20 minutes. Internal provider
retries and separate diagnostic calls are not fully represented in those token totals.

## Evaluation repositories

These are Flask and chi only; p-retry was designated development data. Two ambiguous queries were
excluded after source review, leaving six evaluation queries with eight annotated evidence spans.
The original aggregates remain available for comparison. “Lines” means mean unique source lines
returned for a positive query, not tokens consumed by a downstream agent.
Recall uses every candidate at or above the cutoff, with no output cap (`--top 0`); ordinary CLI
output is capped by default.

| Maximum lines / overlap | Cutoff | Evidence recovered | Mean lines | Unsupported-query candidate chunks |
| --- | ---: | ---: | ---: | ---: |
| 50 / 0 | 0.50 | 7/8 | 80 | 2 |
| 150 / 0 | 0.50 | 8/8 | 214 | 1 |
| 300 / 0 | 0.50 | 8/8 | 406 | 1 |
| 150 / 30 | 0.50 | 7/8 | 215 | 2 |
| 50 / 0 | 0.35 | 8/8 | 119 | 27 |
| 150 / 0 | 0.35 | 8/8 | 279 | 12 |
| 300 / 0 | 0.35 | 8/8 | 441 | 7 |
| 150 / 30 | 0.35 | 8/8 | 315 | 14 |

Unsupported-query chunks are unjudged candidates, **not measured false positives**. Tests and
documentation can contain behavior that the named implementation does not support.

Across all ten reviewed positive queries, the 0.50 cutoff recovered 11/14 annotated spans with
50-line windows, 14/14 with 150 or 300 lines, and 13/14 with overlap. At 0.35, every variant
recovered all 14 spans. Lowering the cutoff to 0.20 added substantial reading workload without
recovering additional annotated spans; unlabelled relevance remains unknown.

## Why score maximization is the wrong objective

In p-retry's non-Error rejection query, two necessary evidence spans fell into 50-line windows
scored 0.79 and 0.37. A 0.50 cutoff loses one span; the larger window keeps both. An agent needs
the evidence, not merely the highest-scoring fragment.

For Flask's refresh-cookie query, the second evidence span scored 0.52 with the 150-line setting
and 0.49 with overlap. That small difference changes recovery at 0.50. It does not prove that
overlap generally hurts: this was a single pass with an unpinned gateway model, without repeated
trials or confidence intervals. It illustrates sensitivity to score and threshold differences;
this run cannot separate a context effect from model variability.

## Decisions and remaining evidence

- Retain 150 lines, no overlap, and the existing default cutoff. Keep window size, overlap,
  cutoff and output cap explicit controls rather than silently tuning them to this corpus.
- For a recall-heavy investigation, `--top 0 --min 0.35` is an available broader selection,
  with a larger verification workload. It is not a guaranteed recall level.
- Test 50 lines at 0.35 against the current default on new, independently annotated queries.
  Predeclare equal downstream reading budgets and measure actual agent task success. Include
  distributed behavior, natural no-match queries, and iterative grep/read baselines.
- Do not prune children based on a parent's low score or shrink context until a score rises.
  No adaptive strategy was tested here, and the fixed comparisons do not establish a need for it.

These are sparse, source-informed, agent-authored labels. The two excluded queries confused an
empty session object with cookie replacement and a deferred timeout response attempt with
guaranteed delivery. The remaining backlog target also omits some verification context, and the
constant-time target concerns password comparison rather than the entire authentication path.
This pilot does not demonstrate exhaustive semantic recall, vulnerability detection quality,
calibrated probabilities, or superiority to an agent using grep.

All 60 artifacts passed offline reconstruction and validation of query identity, source hashes,
complete window coverage, score ranges and counts. The frozen runner and verified engine sources
are retained alongside the data. The maintained runner now rejects incompatible plans and
malformed cached artifacts before reusing them.

[Reviewed tables and validation](analysis.md) · [Raw aggregate and usage](README.md) ·
[Frozen corpus and method](../../../benchmarks/search/README.md) ·
[Research and design reasoning](../../semantic-search-research.md)
