# Adversarial review record

The original uncommitted proof of concept was treated as disposable input. Two independent review passes assessed the candidate against project standards and the user's specification. This record summarizes resolved findings; it does not claim a model-quality benchmark.

## Standards findings

- Missing probability distributions could suppress confidence-filtered findings. Direct responses now require distributions; Gateway omissions fail when a rule requires them. Regression tests exercise both.
- Calibration omitted references and accepted partial/stale reviews. Evaluation now supplies the reader, checks freshness and refuses incomplete samples.
- Remote skill inventories ignored GitHub truncation. Compilation now rejects truncated inventories.
- Missing `@file.md` guidance imports silently disappeared. They now fail compilation.
- Provider model IDs could inject report markup. They now use bounded escaped rendering.

## Specification findings

- Nested AGENTS exceptions were applied additively against conflicting root rules. Compilation now supplies effective ancestor guidance in precedence order, and evaluation selects the deepest applicable compiled source. Tests verify inherited content, selection and invalidation after an ancestor edit.
- Remote branch/tag references could be permanently stale; changing a branch selector could also leave old policy apparently current. A selection hash now tracks explicit source choices independently of pinned commit identities.
- At-least-once queue delivery could race GitHub lookup-then-create operations. A durable per-PR lease serializes workers, outlives the enforced function duration, and uses owner-checked release. Concurrency tests verify overlap rejection and recovery. Transactional exactly-once GitHub writes remain unavailable.

## Additional verification-driven fixes

The npm artifact originally depended on Bun and unpublished workspace source. It now bundles internal code, exposes declarations, and installs under Node independently. A clean consumer test covers TypeScript helper imports, Rust/TS init and an offline report.

The first real Vercel deployment reached Ready but failed at runtime because extensionless ESM imports did not resolve. Explicit `.js` imports and a runtime health route now make that failure observable. Production checks must inspect endpoints as well as the build status.

The live account rejected the default ZDR request because it is on Hobby. No automatic downgrade was added. Synthetic-only tests explicitly disabled ZDR and verified Jev's three primitive contracts. Real repository review quality and installed-App lifecycle remain separate validation requirements.

## 0.2 preset and setup review

The Standards review found no actionable issues in semantic preset design, file scoping, package migration or generated workflow policy. The Spec review found that generic onboarding selected a TypeScript-only filter for other languages. The CLI now supports `--general`, defaults to general TOML outside Cargo/npm repositories, and documents the explicit flag when npm has introduced a package manifest. Mixed repositories are told to widen/remove `include`. The reviewer rechecked the fix with no remaining findings in that scope. Packed CLI checks exercise both general paths and verify existing policy is preserved when adding a workflow.

## 0.3 CLI App setup review

Independent Standards and Spec reviews covered the changes since `8fbfd12`. Standards reproduced a malformed loopback request that could terminate registration; the handler now rejects malformed/non-local request targets, with a real HTTP regression case that continues through successful registration afterward. Spec found a personal-account URL in the repair path for organization-owned Apps; the link now comes from validated App owner metadata and has integration coverage. Publication of the referenced v0.3.0 tag/archive is a release gate. Registration uses a simulated GitHub exchange in tests; existing-App connection, Marketplace provisioning, deployment, PR review and updating the same bot comment have live evidence in status.md.
