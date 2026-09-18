# Sample PR report

The GitHub App's summary comment and one inline comment, generated from a real Jev review of the [showcase demo PR](https://github.com/Kelbie/hunch/pull/9) diff on 2026-09-18. On a PR, each **Where** link opens the inline comment's thread; here they link to code instead. Findings are model judgments, not an accuracy benchmark.

## Summary comment

<!-- hunch:summary -->
### 🔮 Hunch · 7 places to review (2 with errors) · review complete

| | Concern | Where |
| :-: | --- | --- |
| 🔴 | The invoice lookup may trust a caller-supplied tenant ID, allowing access to another tenant's invoices.<br><sub>`demo/tenant-access`</sub> | [`authorization.ts:7`](https://github.com/Kelbie/hunch/blob/e4c4d58c306da78d842c4ed689e29290dfbffa2c/examples/review-showcase/typescript/authorization.ts#L7) |
| 🔴 | A retry may charge the customer twice: each attempt gives the gateway a new idempotency key.<br><sub>`demo/payment-retry`</sub> | [`payment.ts:8`](https://github.com/Kelbie/hunch/blob/e4c4d58c306da78d842c4ed689e29290dfbffa2c/examples/review-showcase/typescript/payment.ts#L8) |
| 🟡 | 🟡 A previously supported edge case may no longer behave correctly.<br><sub>`correctness/edge-case-regression`</sub><br>🟡 A comment or API description may contradict the changed behavior.<br><sub>`docs/contradictory-comment`</sub><br>🟡 A recoverable input or runtime failure may now panic instead of reaching the caller as an error.<br><sub>`rust/panic-on-recoverable-input`</sub> | [`config.rs:3`](https://github.com/Kelbie/hunch/blob/e4c4d58c306da78d842c4ed689e29290dfbffa2c/examples/review-showcase/rust/src/config.rs#L3) |
| 🟡 | A comment or API description may contradict the changed behavior.<br><sub>`docs/contradictory-comment`</sub> | [`cache.ts:3`](https://github.com/Kelbie/hunch/blob/e4c4d58c306da78d842c4ed689e29290dfbffa2c/examples/review-showcase/typescript/cache.ts#L3) |
| 🟡 | Callers may have to coordinate internal steps and intermediate state, making the required order easy to misuse.<br><sub>`demo/checkout-interface`</sub> | [`checkout.ts:11-27`](https://github.com/Kelbie/hunch/blob/e4c4d58c306da78d842c4ed689e29290dfbffa2c/examples/review-showcase/typescript/checkout.ts#L11-L27) |
| 🟡 | 🟡 A failed operation may now be reported as successful completion.<br><sub>`failures/misleading-success`</sub><br>🟡 Do not turn missing data, provider failures, or partial review into a success result.<br><sub>`agents-md/root/preserve-caller-failures`</sub><br>🟡 Report incomplete review coverage explicitly rather than hiding it.<br><sub>`agents-md/root/report-incomplete-coverage-explicitly`</sub> | [`review.ts:3-8`](https://github.com/Kelbie/hunch/blob/e4c4d58c306da78d842c4ed689e29290dfbffa2c/examples/review-showcase/typescript/review.ts#L3-L8) |
| 🟡 | Overlapping asynchronous operations may publish stale state or repeat a side effect.<br><sub>`typescript/async-ordering`</sub> | [`search.ts:5`](https://github.com/Kelbie/hunch/blob/e4c4d58c306da78d842c4ed689e29290dfbffa2c/examples/review-showcase/typescript/search.ts#L5) |

<sub>Reviewed [`e4c4d58`](https://github.com/Kelbie/hunch/blob/e4c4d58c306da78d842c4ed689e29290dfbffa2c) with typesafe-ai/jev. Findings are model judgments, not proven bugs.</sub>

<details>
<summary>Review details</summary>

| Rule | Source | Model result |
| --- | --- | --- |
| demo/tenant-access | config | p(yes)=0.90 ≥ 0.85 |
| demo/payment-retry | config | choice=duplicate-charge (confidence 1.00) |
| correctness/edge-case-regression | hunch:recommended | p(yes)=0.87 ≥ 0.85 |
| docs/contradictory-comment | hunch:recommended | p(yes)=0.94 ≥ 0.85 |
| rust/panic-on-recoverable-input | hunch:rust | p(yes)=0.94 ≥ 0.85 |
| docs/contradictory-comment | hunch:recommended | p(yes)=0.89 ≥ 0.85 |
| demo/checkout-interface | config | score 0.15 &lt; 0.5: The caller must coordinate reservation, payment and finalization, preserving intermediate handles and their ordering. |
| failures/misleading-success | hunch:recommended | p(yes)=0.89 ≥ 0.85 |
| agents-md/root/preserve-caller-failures | agents-md/root | p(yes)=0.95 ≥ 0.75 |
| agents-md/root/report-incomplete-coverage-explicitly | agents-md/root | p(yes)=0.90 ≥ 0.75 |
| typescript/async-ordering | hunch:typescript | p(yes)=0.90 ≥ 0.85 |

Guidance Hunch doesn't check:

- skill/codebase-design: 10 guidance items can't be checked one change at a time; see notChecked in hunch.lock.
- agents-md/root: 10 guidance items can't be checked one change at a time; see notChecked in hunch.lock.

</details>

## Inline comment

Posted on `payment.ts` line 8 as part of a review, so GitHub shows it beside the diff:

<!-- hunch:finding demo%2Fpayment-retry examples%2Freview-showcase%2Ftypescript%2Fpayment.ts -->
🔴 **Error:** A retry may charge the customer twice: each attempt gives the gateway a new idempotency key.

<sub>`demo/payment-retry` · choice=duplicate-charge (confidence 1.00) · from config</sub>

<sub>🔮 Hunch · Not relevant? Resolve this conversation and Hunch won't raise it again on this PR.</sub>
