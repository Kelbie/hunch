# Architecture and adversarial decisions

Hunch has three modules: a portable review engine, a local CLI, and a GitHub App. TypeScript earns its place because the verified Jev Gateway evaluation SDK, Vercel Queues and npm distribution already live in that ecosystem. Reviewed source code is language independent; Rust users need Node for the CLI, not a TypeScript application.

## Interfaces

- `check({config, hunks, lock, client, readFile})` owns rule selection, budgets, evaluation and findings. It returns structured data. It does not authenticate or publish.
- `RepoReader` provides read/list/files for local disk, a Git commit, and GitHub. Policy selection stays outside the engine, and each adapter enforces its own file access restrictions.
- `JevClient.evaluate` normalizes the two real provider contracts. It validates typed output and hides authentication and retries.
- `runReview(job, deps)` owns the GitHub lifecycle. A signed webhook durably enqueues minimal identifiers; the worker reads current PR state, immutable base policy, immutable comparison, and publishes commit-labelled results.

The CLI and App use the same engine and report renderer. The npm artifact bundles Hunch's internal core into a single public package; the core workspace is private. Bun is the development/test tool, not a requirement for npm consumers.

## Alternatives challenged

**Execute arbitrary TypeScript configuration:** familiar, but would allow installed repositories to run code with App credentials. Instead parse a documented literal-only subset. No imports of local executable config, environment access or function execution. TOML feeds the same strict schema. Both files present is an error.

**Ask Jev whether a PR follows an entire skill:** attractive, but fails Jev's atomic-question design and lacks honest architecture coverage. Compile selected guidance using a text model once, review the resulting hunch.lock, then use only Jev for normal reviews. The compiler records unsupported guidance. Compilation is an interpretation, not a proof of skill equivalence. The initial self-policy is explicitly human/agent-curated, not falsely labelled as a model compilation.

**Install every agent convention ourselves:** unnecessary duplication. Use the existing Skills CLI, canonical `.agents/skills`, optional `.claude/skills` fallback, or an explicit local directory. Remote GitHub sources resolve to commits at compilation. No arbitrary HTTP sources or execution of skill scripts. Supporting Markdown is loaded; other assets are not. AGENTS guidance is scoped by directory and compiled, not obeyed as runtime instructions. Nested AGENTS documents compile the effective ancestor guidance together, with later directory-specific instructions taking precedence. Only the deepest applicable compiled AGENTS source runs for a file. This interpretation still needs review in hunch.lock.

**Let Jev choose which rules to omit:** the prototype's routing could create silent false negatives. Apply deterministic scopes and prefilters, preserve source order, and state explicitly when the per-hunk budget omits rules. Limits are safety ceilings, not a promise to review arbitrarily large changes.

**Put the job in waitUntil:** a webhook could acknowledge a job that dies with its function. Vercel Queues durably accepts before HTTP 202 and retries worker failures. GitHub does not redeliver rejected webhooks automatically; deployment instructions include recovery. Queues is a beta dependency isolated to the App.

**Review the mutable PR endpoint:** can attach new code's findings to an old commit. Compare immutable base/head SHAs, skip obsolete queued jobs, recheck both SHAs before publishing. Reports identify the reviewed commit. A push racing the final API write can still leave an older commit's explicitly labelled report; it cannot change which code was reviewed.

**Exactly-once publication without storage:** lookup-then-create alone races. The App now takes a durable per-PR Redis lease before work. Its 360-second lifetime exceeds Vercel's enforced 300-second worker duration; contending workers retry and crashed leases expire. Release is an atomic owner comparison, never an unconditional delete. Do not raise worker duration without raising the lease lifetime. This extra resource is justified by a real concurrency requirement, and remains confined to the App. Sequential retries find the App's existing check/comment; delivery IDs deduplicate enqueueing. GitHub writes cannot participate in a Redis transaction, so transport ambiguity and GitHub visibility delays still prevent an exactly-once guarantee. Reports identify the reviewed head; an older head never updates a newer head's report.

## Trust and coverage

Base policy is trusted by repository owners, but never executed. Config references stay inside the repository. Local symlinks must resolve inside it; hosted policy requires regular committed files. Full file deletion, binary changes and metadata changes require human review. Hunk locations are approximate context locations, not model-located bug lines. Presets ask about behavior and contracts; language questions are scoped by file glob. Missing/malformed provider answers are failures. Missing guidance compilation, stale locks, omitted rules and missing references produce partial coverage, never a passing audit.

Jev can identify a local symptom such as a function that exposes bookkeeping or conceals a failed operation. It cannot establish repository-wide module depth, absence of duplication, correct threat modeling, or skill compliance. Both prompt injection and ordinary false positives/negatives remain possible. All semantic findings start advisory; measure per-rule fixtures before enabling failOnError.

No operational credentials are stored in config or a lock. Diffs and selected context go to the chosen provider. Compiler calls send selected guidance to a separate text model. Gateway calls request ZDR; direct TypeSafe retention follows the account agreement. Probabilities and Hunch's distribution-concentration metric are not empirical accuracy or provider-native confidence.
