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

## PR comment and showcase review

Standards and Spec reviews of `4cb9e0c...6004e70` found no actionable defects. Tests verify that comments lead with concerns, preserve distinct messages, consolidate only identical concerns at identical ranges, retain every contributing rule, and keep incomplete coverage visible. Provenance follows preset questions through severity changes and switches to config when a question is replaced. The showcase's extra questions apply only to their named examples.

A live eight-hunk review encountered Gateway free-tier HTTP 429 responses. The Gateway adapter now permits five SDK retries within a shared 90-second timeout. Independent source review confirmed the SDK propagates that timeout through requests and retry sleeps. It also corrected the timing documentation: 62 seconds is the default backoff total, and GitHub setup/publication overhead means completion within the 300-second worker limit is not guaranteed.

## Semantic search and review context (2026-09-19)

Review baseline: `9c8dc6a16b6cc43e64afe4a781e53cb45fe09a16`. Independent Standards and Spec
passes covered condition search, source coverage, context, localization, CLI/Action/App reporting,
benchmarks and the skill. Findings corrected before merge: location-specific thread reuse and
resolution, consistent window headers, deadline-bounded source reads, one pinned head for source
and links, matching dry-run windows, and preserving the parent after uncertain child attribution.
The only remaining Standards observation is duplicated deterministic selection in dry-run and
execution; both paths have public-interface regression coverage.

The regenerated guidance lock was reviewed. Its inferred `new` lexical gate was removed because
service factories can construct dependencies without that keyword. All model-derived findings
remain advisory. Full tests, typecheck, build and the packed Node artifact pass; the optional
credentialed smoke test is skipped in the ordinary suite. Separate live evidence is retained in
the fixed-window and controlled-localization benchmark directories. This is not a claim that
new hosted delivery/deployment or downstream coding-agent task success was validated.
