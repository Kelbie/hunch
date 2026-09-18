# Live single-section report

This is the new formatter applied to a real Jev response for the checkout section of [showcase PR #8](https://github.com/Kelbie/hunch/pull/8), evaluated locally on 2026-09-18 through Gateway OIDC with the public repository’s approved ZDR opt-out. It demonstrates an ordered score and a skill-derived boolean concern combined without losing attribution. It is not the full hosted PR report or an accuracy benchmark.

<!-- hunch:summary -->
## Hunch review

**1 possible issue to review.**

### [examples/review-showcase/typescript/checkout.ts:11–27](https://github.com/Kelbie/hunch/blob/02b221b1023e94c2aed53091d65d9e941d7e2dc6/examples/review-showcase/typescript/checkout.ts#L11-L27)

1. Callers may have to coordinate internal steps and intermediate state, making the required order easy to misuse.

Reviewed [02b221b](https://github.com/Kelbie/hunch/blob/02b221b1023e94c2aed53091d65d9e941d7e2dc6).

<details>
<summary>Review details</summary>

These are configured concerns selected by the model. Links identify changed sections, not exact offending lines.

| Issue | Rule | Source | Model result |
| --- | --- | --- | --- |
| 1 | demo/checkout-interface | config | score 0.08 &lt; 0.5: The caller must coordinate reservation, payment and finalization, preserving intermediate handles and their ordering. |
| 1 | skill/codebase-design/caller-bookkeeping | skill/codebase-design | p(yes)=0.90 ≥ 0.75 |

Guidance requiring human review:

- skill/codebase-design: 1 guidance item(s) require human review (see hunch.lock).
- agents-md/root: 1 guidance item(s) require human review (see hunch.lock).

Model: typesafe-ai/jev. Scores are estimates, not measured accuracy.

</details>
