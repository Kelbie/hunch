# Review showcase

These standalone examples provide a working baseline for demonstration PRs. They are not imported by Hunch or deployed. The baseline preserves each visible contract; a demo PR introduces deliberate regressions and must not be merged.

The root Hunch config includes this directory. It applies general, TypeScript and Rust presets plus narrowly scoped examples of `noul`, `choice` and `score`. Installed `codebase-design` skill rules and `AGENTS.md` guidance also apply through the existing, manually reviewed `hunch.lock`.

| File | Review capability |
| --- | --- |
| `typescript/authorization.ts` | Custom boolean (`noul`) question about cross-tenant access |
| `typescript/payment.ts` | Custom `choice` classifying retry safety |
| `typescript/checkout.ts` | Custom `score` and skill guidance about caller-owned internal steps |
| `typescript/search.ts` | TypeScript preset: stale asynchronous results |
| `typescript/review.ts` | General preset, project rule and AGENTS guidance: failure reported as success |
| `typescript/cache.ts` | General preset: comment contradicting behavior |
| `rust/src/config.rs` | Rust preset: reachable panic on recoverable input |
| `rust/src/storage.rs` | Rust preset: error distinction needed for recovery |

All findings remain model judgments. This showcase demonstrates the integration and the rule types, not an accuracy benchmark. The PR comment keeps concerns visible and places scores and rule origins under **Review details**.
