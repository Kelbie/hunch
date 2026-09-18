# Verified implementation status — 2026-09-18

- Public repository: https://github.com/Kelbie/hunch
- Backend: https://hunch-ten-alpha.vercel.app/api/health
- Vercel project: `kelbies-projects/hunch`, Node 22.
- Deployed engine loads successfully. Health returns HTTP 200 with `setup_required`, `githubApp: false`, `leaseStore: false`. POST to the private queue worker returns 404 publicly.
- Local checks: 51 passing tests, one credential-gated live test skipped; strict TypeScript checks and builds passed. The independent live smoke script verified all three Jev primitives on synthetic public inputs through Gateway OIDC.
- Clean npm consumer validation passed for Node CLI execution, declarations, TS/Rust/general config initialization, GitHub workflow generation without overwriting policy, and an offline report. The GitHub preview tarball is usable without npm registry publication.
- Two independent adversarial reviewers rechecked their reported fixes and found no remaining blocker within that bounded scope. See adversarial-review.md.

## Activation still required

1. Register/install the GitHub App and configure its ID, private key and webhook secret.
2. Connect the Upstash Redis lease store and its REST credentials.
3. Decide the Gateway privacy setting. This team's Hobby plan rejected enforced ZDR (HTTP 403). Hunch's default remains enabled; use an eligible plan or deliberately opt out in project config. Only synthetic test data was sent with ZDR off.
4. Install/authorize Vercel's GitHub integration for this repository if automatic deployments are desired. CLI deployment works; automatic Git linkage was rejected because that integration is unavailable.
5. Confirm publishing access to the `@hunch` scope and authenticate npm before publishing `@hunch/cli` to the registry. GitHub's preview archive provides installation meanwhile.

The GitHub App has not yet reviewed a real PR. Queue delivery, hosted Redis and installed-App permissions need the deployment acceptance checks in deploy.md. No claim is made about real-project precision/recall, compiler semantic fidelity, or a completed audit of Hunch itself. The committed self-policy is manually curated from installed guidance; it is not falsely attributed to a live compiler run.

## 0.2 preset and onboarding validation

Recommended now has four language-independent behavior checks; TypeScript and Rust each add two file-scoped checks. The package is named `@hunch/cli`. `hunch init --github` generates the Actions workflow; `--general` handles languages beyond TS/Rust. Standards review found no issues; the spec review's general-language onboarding finding was fixed and independently rechecked.

Sixteen synthetic fixtures (one positive and one counterexample per rule) are checked into `examples/presets`. `HUNCH_SMOKE_ZDR=false bun scripts/preset-smoke.ts` sends only those fixtures through Gateway on Hobby. In this run, the first five cases matched expectations (allowed fallback, stale-result guard, stale-result regression, contradictory comment, updated comment). The provider then returned HTTP 429; a retry also received 429. The remaining eleven cases were not evaluated live. This is partial synthetic evidence, not a real-project accuracy benchmark.
