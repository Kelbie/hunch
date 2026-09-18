# Verified implementation status — 2026-09-18

- Public repository: https://github.com/Kelbie/hunch
- Backend: https://hunch-ten-alpha.vercel.app/api/health
- Vercel project: `kelbies-projects/hunch`, Node 22.
- Production is configured: `/api/health` returns HTTP 200 with `githubApp: true` and `leaseStore: true`. App `hunch-review` (4985597) is installed; Marketplace Redis is connected on its free plan. Credentials were uploaded through `hunch app connect` without printing values.
- **Live proof:** [demo PR #7](https://github.com/Kelbie/hunch/pull/7), [bot report](https://github.com/Kelbie/hunch/pull/7#issuecomment-5724831365), check run `105473140108`. A real push webhook reached Vercel Queues, acquired the Redis lease, authenticated as the installation, called Jev and published a commit-labelled comment/check. Head `f78e1ead88d2085d8688b4015b1e5b2bb019e2f9`: 1 hunk, 14 questions, 2,022 input tokens, three advisory findings for the intentional failure-as-success bug. Check conclusion: neutral.
- An explicit `/hunch recheck` then completed with check `105473389751` and updated that same bot comment. Exactly one Hunch comment remained on the PR.
- Local checks: 59 passing tests, one credential-gated live test skipped; strict TypeScript checks, builds and packed Node consumer passed. Registration callback tests simulate GitHub's exchange; the existing-App connection and deployment were exercised live. A second live App registration has not been attempted.
- Clean npm consumer validation passed for Node CLI execution, declarations, TS/Rust/general config initialization, GitHub workflow generation without overwriting policy, and an offline report. The GitHub preview tarball is usable without npm registry publication.
- Two independent adversarial reviewers rechecked their reported fixes and found no remaining blocker within that bounded scope. See adversarial-review.md.

## Remaining operational work

1. Install/authorize Vercel's GitHub integration if automatic deployments are desired. CLI deployment works; automatic Git linkage was rejected because that integration is unavailable.
2. Authenticate npm as the `kelbie` user and publish `@kelbie/hunch` to the registry. The package was renamed from the unpublished `@hunch/cli` in 0.3.1, because `@hunch` requires owning that npm organization and the unscoped `hunch` name belongs to an unrelated package.
3. Validate fork isolation and overlapping/head-change behavior in deployment acceptance tests before treating the check as a merge requirement. These paths have local integration coverage, but the live demo alone does not prove them.

The owner explicitly approved `zeroDataRetention: false` for this public repository on Vercel Hobby; that setting is committed in the trusted base policy. The default for consumers remains enforced ZDR. The first recheck used the demo's old base policy and failed; updating the demo branch from main activated the approved policy, and the push review succeeded. No claim is made about broad precision/recall, compiler semantic fidelity, or a completed audit of Hunch itself. The committed self-policy is manually curated from installed guidance, not falsely attributed to a live compiler run.

## 0.2 preset and onboarding validation

Recommended now has four language-independent behavior checks; TypeScript and Rust each add two file-scoped checks. The package was named `@hunch/cli` at the time (renamed to `@kelbie/hunch` in 0.3.1). `hunch init --github` generates the Actions workflow; `--general` handles languages beyond TS/Rust. Standards review found no issues; the spec review's general-language onboarding finding was fixed and independently rechecked.

Sixteen synthetic fixtures (one positive and one counterexample per rule) are checked into `examples/presets`. `HUNCH_SMOKE_ZDR=false bun scripts/preset-smoke.ts` sends only those fixtures through Gateway on Hobby. In this run, the first five cases matched expectations (allowed fallback, stale-result guard, stale-result regression, contradictory comment, updated comment). The provider then returned HTTP 429; a retry also received 429. The remaining eleven cases were not evaluated live. This is partial synthetic evidence, not a real-project accuracy benchmark.

## Comment format and broader showcase

The deployed App now leads with plain-language concerns grouped by linked code sections. Rule sources and model scores are collapsed under Review details; incomplete coverage remains visible. Identical messages at the same range share one issue while retaining each contributing rule. PR #7's existing bot comment was reformatted from check `105473389751` without another evaluation; its original findings and scores were preserved.

[Showcase PR #8](https://github.com/Kelbie/hunch/pull/8) contains eight intentional TypeScript/Rust regressions covering general and language presets, custom boolean (`noul`), choice and score questions, installed skill guidance, and AGENTS.md. Both baseline and changed examples pass strict TypeScript compilation and Cargo checking. Ordinary CI passed. The full hosted Jev review did **not** complete: check `105476314588` failed with Gateway HTTP 429 after a 65-second retry cycle. No complete report was published for this PR.

A separate local evaluation of the actual checkout section produced a score finding and a matching codebase-design skill finding; [the sample report](sample-report.md) preserves that limited evidence. A standalone choice probe also completed, but neither proves the full PR's detection coverage.

The owner chose to retain the free tier. PR #8 remains open as a draft, so queued review jobs skip it and avoid further provider calls. When ready to retry, mark it ready for review. The formatter and bounded Gateway retries are deployed; the v0.3.0 preview package predates these changes.
