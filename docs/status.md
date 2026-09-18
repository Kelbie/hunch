# Verified implementation status — 2026-09-18

- Public repository: https://github.com/Kelbie/hunch
- Backend: https://hunch-ten-alpha.vercel.app/api/health
- Vercel project: `kelbies-projects/hunch`, Node 22.
- Deployed engine loads successfully. Health returns HTTP 200 with `setup_required`, `githubApp: false`, `leaseStore: false`. POST to the private queue worker returns 404 publicly.
- Local checks: 50 passing tests, one credential-gated live test skipped; strict TypeScript checks and builds passed. The independent live smoke script verified all three Jev primitives on synthetic public inputs through Gateway OIDC.
- Clean npm consumer validation passed for Node CLI execution, declarations, TS/Rust config initialization and an offline report. The GitHub preview tarball is usable without npm registry publication.
- Two independent adversarial reviewers rechecked their reported fixes and found no remaining blocker within that bounded scope. See adversarial-review.md.

## Activation still required

1. Register/install the GitHub App and configure its ID, private key and webhook secret.
2. Connect the Upstash Redis lease store and its REST credentials.
3. Decide the Gateway privacy setting. This team's Hobby plan rejected enforced ZDR (HTTP 403). Hunch's default remains enabled; use an eligible plan or deliberately opt out in project config. Only synthetic test data was sent with ZDR off.
4. Install/authorize Vercel's GitHub integration for this repository if automatic deployments are desired. CLI deployment works; automatic Git linkage was rejected because that integration is unavailable.
5. Authenticate npm before publishing `@kelbie/hunch` to the registry. GitHub's preview archive provides installation meanwhile.

The GitHub App has not yet reviewed a real PR. Queue delivery, hosted Redis and installed-App permissions need the deployment acceptance checks in deploy.md. No claim is made about real-project precision/recall, compiler semantic fidelity, or a completed audit of Hunch itself. The committed self-policy is manually curated from installed guidance; it is not falsely attributed to a live compiler run.
