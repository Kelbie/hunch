# Fixed-window search pilot

Generated 2026-09-19T19:41:36.241Z. Hunch 0.12.0.

Sparse, agent-authored source targets were frozen before model evaluation. Evidence recall is the fraction of annotated spans whose every line occurs in returned candidates. It is not exhaustive semantic recall or precision. Unsupported-query control matches require adjudication; they are not automatically false positives.

| Variant | Threshold | Evidence recovered | Fully recovered positive cases | Mean unique source lines returned | Control chunks |
| --- | ---: | ---: | ---: | ---: | ---: |
| lines-50 | 0.2 | 16/16 | 12/12 | 2183 | 732 |
| lines-50 | 0.35 | 16/16 | 12/12 | 197 | 28 |
| lines-50 | 0.5 | 13/16 | 9/12 | 94 | 2 |
| lines-50 | 0.7 | 11/16 | 8/12 | 50 | 0 |
| lines-150 | 0.2 | 16/16 | 12/12 | 2379 | 313 |
| lines-150 | 0.35 | 16/16 | 12/12 | 296 | 12 |
| lines-150 | 0.5 | 16/16 | 12/12 | 210 | 1 |
| lines-150 | 0.7 | 14/16 | 10/12 | 108 | 0 |
| lines-300 | 0.2 | 16/16 | 12/12 | 2511 | 220 |
| lines-300 | 0.35 | 16/16 | 12/12 | 374 | 7 |
| lines-300 | 0.5 | 16/16 | 12/12 | 316 | 1 |
| lines-300 | 0.7 | 13/16 | 9/12 | 173 | 0 |
| lines-150-overlap-30 | 0.2 | 16/16 | 12/12 | 2541 | 347 |
| lines-150-overlap-30 | 0.35 | 16/16 | 12/12 | 338 | 14 |
| lines-150-overlap-30 | 0.5 | 15/16 | 11/12 | 219 | 2 |
| lines-150-overlap-30 | 0.7 | 14/16 | 10/12 | 132 | 0 |

## Measured usage

| Variant | Logical requests | Reported input tokens | Summed evaluation seconds |
| --- | ---: | ---: | ---: |
| lines-50 | 6135 | 5781009 | 502.2 |
| lines-150 | 2800 | 3799468 | 221.7 |
| lines-300 | 2095 | 3378105 | 126.1 |
| lines-150-overlap-30 | 3010 | 4286851 | 225.1 |

Provider retries may consume additional time and tokens not exposed by the adapter. Timings exclude cloning and annotation. Gateway model names are unpinned; this does not establish reproducibility across future model revisions.

## Fixed lexical probe

Literal case-insensitive OR terms were frozen with the queries. Matching lines receive 20 lines of context either side. This is a diagnostic baseline, not an agent using iterative grep and file reads, and cannot establish superiority to grep.

| Case | Evidence recovered | Unique lines returned |
| --- | ---: | ---: |
| p-retry-abort-cleanup | 1/1 | 591 |
| p-retry-non-error | 2/2 | 825 |
| p-retry-veto | 1/1 | 803 |
| p-retry-unwrap | 2/2 | 795 |
| p-retry-non-error-control | control | 807 |
| flask-bad-signature | 1/1 | 6167 |
| flask-refresh-cookie | 2/2 | 6641 |
| flask-close-iterator | 1/1 | 4329 |
| flask-context-reset | 1/1 | 10512 |
| flask-encryption-control | control | 6164 |
| chi-panic-abort | 2/2 | 4581 |
| chi-constant-time | 1/1 | 884 |
| chi-backlog | 1/1 | 562 |
| chi-deadline | 1/1 | 4241 |
| chi-kill-control | control | 921 |

## Sources

- [p-retry v6.2.1](https://github.com/sindresorhus/p-retry/tree/0a288cc203d657eb20e317163ae21834b86ba1bb) — 0a288cc203d657eb20e317163ae21834b86ba1bb, MIT, development.
- [flask 3.1.0](https://github.com/pallets/flask/tree/ab8149664182b662453a563161aa89013c806dc9) — ab8149664182b662453a563161aa89013c806dc9, BSD-3-Clause, evaluation.
- [chi v5.2.1](https://github.com/go-chi/chi/tree/71307f9b7e4e9527638bc951c42b782cd1560331) — 71307f9b7e4e9527638bc951c42b782cd1560331, MIT, evaluation.

Machine-readable per-case results are in summary.json; raw scores and chunk hashes are in the individual JSON artifacts. Unlabelled matches remain unjudged. This pilot does not measure downstream coding-task success, calibrate probabilities, or justify adaptive pruning.
