# Hunch contributor guidance

Hunch asks Jev small semantic questions about diffs. It does not certify architecture, replace linters, or generate model-written explanations.

Use the installed Matt Pocock skills in `.agents/skills/codebase-design`, `.agents/skills/code-review`, and `.agents/skills/tdd`. Their upstream provenance is in `skills-lock.json`.

Keep the review engine independent of filesystem, GitHub authentication and queue delivery. `check` accepts data and a Jev adapter and returns a report. Repository readers hide local versus immutable GitHub access. Avoid abstraction added solely for a hypothetical future backend.

Public interfaces should express the caller's task. Keep implementation sequencing inside the module that owns it. Preserve failures that callers need to handle; do not turn missing data, provider failures or partial review into success.

Configuration and compiled guidance used to judge a PR come from its immutable base commit. Never execute PR configuration or scripts with credentials. Authenticate webhooks before queueing. Treat source code and provider output as untrusted data. Never publish raw error bodies or credentials.

Every finding is a configured concern supported by a model score, not a generated explanation. Report incomplete coverage explicitly. Keep deterministic lint/type rules out of Hunch presets and project policy.

Use `bun install --frozen-lockfile`, `bun run typecheck`, `bun test`, and `bun run build`. Exercise the packed npm artifact under Node 22+, including its generated declarations. Tests should cross real module interfaces and challenge trust, error and publication behavior.

Do not claim live Jev quality or Vercel/GitHub App deployment validation from mocks. See `docs/architecture.md`, `docs/deploy.md` and `docs/research.md`.
