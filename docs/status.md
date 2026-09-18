# Verified implementation status — 2026-09-18

- Public repository: https://github.com/Kelbie/hunch
- Backend: https://hunch-ten-alpha.vercel.app/api/health
- Vercel project: `kelbies-projects/hunch`, Node 22.
- Production is configured: `/api/health` returns HTTP 200 with `githubApp: true` and `leaseStore: true`. App `hunch-review` (4985597) is installed; Marketplace Redis is connected on its free plan. Credentials were uploaded through `hunch app connect` without printing values.
- **Live proof:** [demo PR #7](https://github.com/Kelbie/hunch/pull/7), [bot report](https://github.com/Kelbie/hunch/pull/7#issuecomment-5724831365), check run `105473140108`. A real push webhook reached Vercel Queues, acquired the Redis lease, authenticated as the installation, called Jev and published a commit-labelled comment/check. Head `f78e1ead88d2085d8688b4015b1e5b2bb019e2f9`: 1 hunk, 14 questions, 2,022 input tokens, three advisory findings for the intentional failure-as-success bug. Check conclusion: neutral.
- Local checks: 55 passing tests, one credential-gated live test skipped; strict TypeScript checks, builds and packed Node consumer passed. Registration callback tests simulate GitHub's exchange; the existing-App connection and deployment were exercised live. A second live App registration has not been attempted.
- Clean npm consumer validation passed for Node CLI execution, declarations, TS/Rust/general config initialization, GitHub workflow generation without overwriting policy, and an offline report. The GitHub preview tarball is usable without npm registry publication.
- Two independent adversarial reviewers rechecked their reported fixes and found no remaining blocker within that bounded scope. See adversarial-review.md.

## Remaining operational work

1. Install/authorize Vercel's GitHub integration if automatic deployments are desired. CLI deployment works; automatic Git linkage was rejected because that integration is unavailable.
2. Confirm publishing access to the `@hunch` scope and authenticate npm before publishing `@hunch/cli` to the registry. GitHub's preview archive provides installation meanwhile.
3. Validate fork isolation and overlapping/head-change behavior in deployment acceptance tests before treating the check as a merge requirement. These paths have local integration coverage, but the live demo alone does not prove them.

The owner explicitly approved `zeroDataRetention: false` for this public repository on Vercel Hobby; that setting is committed in the trusted base policy. The default for consumers remains enforced ZDR. The first recheck used the demo's old base policy and failed; updating the demo branch from main activated the approved policy, and the push review succeeded. No claim is made about broad precision/recall, compiler semantic fidelity, or a completed audit of Hunch itself. The committed self-policy is manually curated from installed guidance, not falsely attributed to a live compiler run.

## 0.2 preset and onboarding validation

Recommended now has four language-independent behavior checks; TypeScript and Rust each add two file-scoped checks. The package is named `@hunch/cli`. `hunch init --github` generates the Actions workflow; `--general` handles languages beyond TS/Rust. Standards review found no issues; the spec review's general-language onboarding finding was fixed and independently rechecked.

Sixteen synthetic fixtures (one positive and one counterexample per rule) are checked into `examples/presets`. `HUNCH_SMOKE_ZDR=false bun scripts/preset-smoke.ts` sends only those fixtures through Gateway on Hobby. In this run, the first five cases matched expectations (allowed fallback, stale-result guard, stale-result regression, contradictory comment, updated comment). The provider then returned HTTP 429; a retry also received 429. The remaining eleven cases were not evaluated live. This is partial synthetic evidence, not a real-project accuracy benchmark.
