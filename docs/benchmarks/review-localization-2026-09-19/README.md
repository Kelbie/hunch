# Controlled review localization probe

Twenty live Jev evaluations on five synthetic, agent-authored cases, captured 2026-09-19. Fixtures and variants were fixed before the calls. This tests a narrow failure-handling pattern, not general audit quality. Gateway model is unpinned; retention enforcement was disabled for public synthetic inputs.

| Variant | Planted target lines recovered | Highlighted lines on positive cases | Findings on two negative controls | Logical requests | Reported input tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| patch-only | 4/4 | 65 | 0 | 5 | 4861 |
| small-with-context | 4/4 | 25 | 0 | 14 | 16020 |
| contextual | 4/4 | 65 | 0 | 5 | 6258 |
| localized | 4/4 | 21 | 0 | 21 | 32817 |

All variants recovered all planted target lines; the two negative controls returned no findings. Small windows reduced highlighted source without losing these targets. Localization reduced source further but produced two ranges for one planted defect and three for two defects. Some highlighted ranges were adjacent context rather than the annotated causal line. These extra ranges require inspection; they are not proof of additional defects.

Keep localization opt-in. Do not select an algorithm by its highest score or assume binary partition scores are monotonic. Both children receive the whole parent and counterevidence; no negative parent is used to prune baseline coverage. Next evidence should include independently labeled removal-only and distributed defects, repeated runs and reading-budget-matched agent comparisons.

The missing-catch-context fixture was detected even without its surrounding catch. It therefore does not establish a measured recall gain from added context. The unrelated-edit control only shows one successful distinction between changed code and a nearby pre-existing defect.

`manifest.json` contains fixtures, parameters and source hashes. Exact runner and engine sources are archived beside the raw complete reports and `summary.json`. Subsequent correctness fixes are covered by tests, not retroactively attributed to these model results. A fresh live probe uses `bun scripts/review-benchmark.ts <fresh-directory> --live`.
