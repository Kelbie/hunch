# Repository-wide semantic search for coding agents

Researched 2026-09-19. This is a primary-source research and design record, not a
Jev benchmark. Repository observations refer to the starting implementation at
`9c8dc6a16b6cc43e64afe4a781e53cb45fe09a16`; recommendations may be implemented
separately. Research findings from other models do not establish Jev quality.

The subsequent [fixed-window Jev pilot](benchmarks/fixed-windows-2026-09-19/conclusions.md)
records a small live comparison on three pinned public repositories. It supports retaining the
current default and investigating smaller windows at a lower cutoff; it does not establish an
optimal setting or justify adaptive pruning.

## Product purpose and the three different questions

Hunch's useful distinction is **evaluating a natural-language condition against
every eligible source window**, without a lexical or embedding shortlist deciding
which windows reach the classifier. Exhaustive dispatch is achievable; exhaustive
semantic recall is not guaranteed. A completed sweep means all declared windows
were evaluated successfully, not that every relevant behavior was found.

Three user tasks need different contracts:

| Task | Question | Output the calling agent needs |
| --- | --- | --- |
| Condition search | Does this code satisfy this specific condition? | Candidate source ranges and the exact condition scored |
| Change preparation | Which code matters to this requested change? | Implementation, contracts, callers, tests and precedents |
| Continuous review | Does this change exhibit a configured concern? | Advisory findings tied to trusted policy, revisions and coverage |

The existing `find` implements change preparation with five fixed facets. Its
prompt explicitly says that nothing is being judged and asks the classifier to
reject uncertainty. That framing should not silently reinterpret a condition such
as “a failed read becomes an empty success.” The review engine already supports
configured conditions, but setting up ongoing policy is unnecessary ceremony for
an exploratory search. Keep the three intentions explicit while sharing source
enumeration, bounded evaluation and coverage accounting.

Use exact search for known symbols and strings, a parser/static analyzer for
structural or data-flow properties it can express, and semantic search for
behavior whose spelling is unknown. The useful agent workflow combines these
tools; replacing every `rg` call with a model adds latency without necessarily
adding evidence.

## What the research supports

The table distinguishes peer-reviewed publications, author-reported acceptance
and preprints. Dates and status are the source records available on the research
date. This is a targeted survey, not an exhaustive systematic review.

| Primary source | Status | Result reported by its authors | Implication for Hunch |
| --- | --- | --- | --- |
| [Lost in the Middle: How Language Models Use Long Contexts](https://aclanthology.org/2024.tacl-1.9/) | TACL journal, 2024 | Retrieval and QA performance changes with evidence position; long windows can underuse evidence in the middle. | Test position and distractors. A larger context window is not a quality guarantee. The studied models are older than Jev. |
| [PrimeVul: Vulnerability Detection with Code Language Models: How Far Are We?](https://arxiv.org/abs/2403.18624), [authors' artifact](https://github.com/DLVulDet/PrimeVul) | ICSE 2025; conference acceptance recorded in artifact | Dataset noise, duplicates and unrealistic evaluation settings can inflate vulnerability-detection results. Their stringent evaluations expose substantial limitations. | Use deduplicated, repository/time-separated evaluation and matched vulnerable/fixed examples; avoid treating generic accuracy as audit usefulness. |
| [Benchmarking LLMs and LLM-based Agents in Practical Vulnerability Detection for Code Repositories](https://aclanthology.org/2025.acl-long.1490/) | ACL 2025 | JITVul links functions to introducing/fixing commits; agents using interprocedural context outperform the studied isolated LLM setups but remain inconsistent. | Separate locating suspicious code from verifying its behavior with callers and guards. |
| [CoRet: Improved Retriever for Code Editing](https://aclanthology.org/2025.acl-short.62/) | ACL 2025 | A retriever trained for editing combines code semantics, repository structure and call-graph dependencies; authors report improved recall on their localization datasets. | Change preparation needs supporting context, not just text that resembles an issue. This is not evidence that adding arbitrary graph infrastructure improves Hunch. |
| [CoIR: A Comprehensive Benchmark for Code Information Retrieval Models](https://aclanthology.org/2025.acl-long.1072/) | ACL 2025 | Ten datasets span several code retrieval tasks and domains. | Useful retrieval baseline material, but snippet matching alone does not establish whole-repository condition-search recall. |
| [CORE-Bench: A Comprehensive Benchmark for Code Retrieval in the Era of Agentic Coding](https://arxiv.org/abs/2606.11864v3) | August 24, 2026 revision; authors report EMNLP 2026 Main acceptance on arXiv | Separates understanding, issue-to-edit localization and broader context retrieval; reports degradation when embedding models move from traditional code search to agentic repository tasks. | Evaluate both edit locations and useful supporting files. Do not label every unchanged file irrelevant. Acceptance was not independently verified against proceedings. |
| [Agent Retrieval Bench](https://arxiv.org/abs/2607.24882) | July 27, 2026 preprint | Evaluates task-specific context retrieval and natural no-match cases; thresholds calibrated on artificial wrong-repository controls do not transfer reliably to natural no-match cases. | Include real queries with no relevant code, rather than evaluating only positive tasks or easy synthetic negatives. |
| [ContextBench](https://arxiv.org/abs/2602.05892v3) | February 11, 2026 revision, preprint | Human-annotated contexts allow process-level precision, recall and efficiency measurement; authors observe gaps between context explored and used by agents. | Evaluate what the downstream agent actually reads and uses, in addition to what search returns. |
| [How Does Chunking Affect Retrieval-Augmented Code Completion?](https://arxiv.org/abs/2605.04763) | May 6, 2026 preprint | Controlled comparisons report non-monotonic chunk-size effects; function chunking underperforms alternatives in the studied completion settings. | Do not assume functions are always the best chunks or a larger window is always better. Completion results motivate experiments, not a Jev-specific default. |
| [VulnGym: Benchmarking Coding Agents for Repository-Level Vulnerability Detection](https://arxiv.org/abs/2608.02001) | August 3, 2026 preprint | Annotates repository vulnerabilities with entry points, critical operations and traces; includes oracle subtasks to diagnose localization and evidence-construction failures separately. | Measure whether search finds necessary evidence independently of whether the downstream agent can prove the issue. |
| [VEX-Bench: Benchmarking LLM Agents for Assessing Exploitability of Software Supply Chain Vulnerabilities](https://arxiv.org/abs/2609.08040) | September 7, 2026 preprint | Distinguishes binary exploitability decisions from finer justification classifications across upstream and downstream repositories. | A plausible yes/no classification is weaker than a verified causal explanation. Hunch should return source evidence and leave verification to the caller. |
| [Context-Enhanced Vulnerability Detection Based on Large Language Model](https://arxiv.org/abs/2504.16877) | April 23, 2025 preprint; related author manuscript inspected | Program-analysis-derived context abstractions help the studied models; effective granularity varies by model. | Context expansion should follow dependencies and be measured. The author-hosted `TOSEM25_ProcVD.pdf` contains placeholder venue/DOI metadata, so this note does not claim verified journal publication. |
| [Restoring Calibration for Aligned Large Language Models](https://proceedings.mlr.press/v267/xiao25b.html) | ICML 2025 | Examines overconfidence after preference alignment and methods for restoring calibration. | Calibration depends on model and domain. This paper does not measure Jev; validate Hunch's own probabilities against labels before interpreting a threshold as an error rate. |

Recent preprints are useful experimental leads, not stronger evidence merely
because they are newer. Security datasets also cover a narrower task than Hunch's
generic behavior search. No reviewed source demonstrates that Jev plus recursive
chunk splitting beats a fixed exhaustive sweep on Hunch's task distribution.

## Jev-specific constraints

TypeSafe currently documents `jev-1.13.0`, $0.042 per million input tokens, a 64k
total request limit and a separate 32k limit for state plus the longest question.
State is shared across questions, but question text still contributes input
tokens. Log the returned model identity; pin the direct model for controlled
experiments. These are provider claims and mutable commercial limits.
[TypeSafe models](https://docs.typesafe.ai/models)

TypeSafe explicitly documents literal interpretation, weak indirection, accuracy
loss from irrelevant context, adversarial-state sensitivity and a lack of expected
algebraic identities between separately phrased questions. Ask a direct condition,
name the target source, keep arithmetic in code and do not assume equivalent
question forms share thresholds. A restrictive prompt does not make repository
comments trusted. [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

Illustrative direct-provider arithmetic: ten million **billed input tokens** cost
`10 × $0.042 = $0.42` at that listed price. This is not an estimate for any particular
repository: repeated context, questions, retries and refinement add tokens.
Show observed usage and a dry-run scope; remove unconditional claims that any
whole repository costs less than a dollar. Request count and latency also matter
to an interactive agent.

## Adaptive windows: useful experiment, unsafe binary-search assumption

This section is design reasoning inferred from the research, not a published
guarantee or a measured Jev improvement.

Let `s(q, W)` be the score for condition `q` on source window `W`. There is no
established monotonic relationship between `s(q, W)` and `s(q, W/2)`. For example,
the child containing a write may omit its authorization guard; the parent may
show that the suspected unguarded write is safe. Conversely, a parent containing
several unrelated functions may obscure a real match. A condition can also require
two halves together. Even when an ideal existential predicate is monotone over
sets of independently meaningful examples, noisy model scores over partial code
need not inherit that property.

Consequently, dropping a whole subtree because its parent scored below a threshold
can lose exactly the unusual code that a repository-wide sweep is intended to
find. Repeatedly shrinking or expanding until the score is highest also selects
for model error: a context-stripped fragment can be confidently wrong. The
optimization target should be useful evidence under a reading budget, not maximum
self-reported probability.

A conservative experiment has these stages:

1. **Cover:** enumerate the declared source corpus and score every baseline window.
   Preserve exact source ranges, imports/supporting context, and a ledger of
   skipped, failed and unattempted windows. This establishes operational coverage.
2. **Localize:** for a bounded set of candidates, evaluate both smaller children,
   preferably at syntactic boundaries. Keep the scored parent as a fallback if
   both children lose the signal or refinement fails. Record the relationship;
   never relabel an inherited parent score as a fresh child judgment.
3. **Expand:** when the decision depends on context, inspect the containing symbol,
   adjacent lines, definitions or callers. Growth and splitting solve different
   problems. A “needs context” score is a routing hint, not a reliable oracle for
   all missing evidence.
4. **Return:** deduplicate overlapping evidence, retain enough surrounding code to
   understand it, and report baseline coverage separately from refinement
   completion and output truncation.

An initial implementation can expose a deterministic chunk-size control and a
small overlapping-window experiment. AST-based chunking and call-graph expansion
are candidates only after language-specific evaluation shows a benefit. Preserve
a language-independent fallback and report parse failures. Every extra strategy
needs comparison to the simple exhaustive baseline.

Do not call a refined result complete merely because the baseline finished when
the user explicitly requested refinement and it was interrupted. Conversely,
returning the top 20 from 200 qualifying matches is output truncation, not an
unsearched repository; disclose both independently.

## Comparable tools and the gap Hunch could occupy

| Tool | Documented mechanism | Relationship to Hunch |
| --- | --- | --- |
| [Mixedbread mgrep](https://github.com/mixedbread-ai/mgrep) | Cloud-backed file indexing, natural-language top-k retrieval and reranking, with coding-agent integrations | A close agent-facing UX comparison. Its documented retrieval contract does not promise one explicit predicate evaluation for every source window. Background upload/indexing is also a different operational contract. |
| [LlamaIndex SemTools](https://github.com/run-llama/semtools) | Local embedding/cosine search with configurable context and workspace caching; separate parsing and agent commands | A useful lightweight semantic-search baseline, including local-only search. Similarity retrieval and literal-condition classification answer different questions. |
| [Semgrep](https://github.com/semgrep/semgrep) | Structural static analysis with source-like rules and agent/MCP integration | Prefer it for expressible code patterns. Its deterministic analysis complements Hunch's natural-language hypotheses; “semantic grep” alone is too ambiguous to explain Hunch. |

These are mechanism comparisons based on first-party documentation, not a
performance ranking. No comparative tool was installed or benchmarked for this
note. Hunch's proposed niche is a cheap, explicit **semantic predicate sweep**
with honest coverage and evidence suitable for a stronger coding agent.

## Real coding-agent workflows

These are proposed interaction patterns, not additional undocumented CLI commands.

**Debug an intermittent failure.** The user says, “Sometimes a read failure clears
the saved state.” The agent searches the repository for the positive, local
condition “a storage read error is converted into an empty or missing value.” It
reads candidate source, follows the returned functions with symbol search, traces
their callers, and writes a regression test. A negative result means no window
passed that classifier threshold; it does not establish that the failure cannot
happen. Searching a broader symptom next is a deliberate new hypothesis.

**Prepare a cross-cutting change.** For “Add cancellation to exports,” task retrieval
should return export implementations, cancellation contracts, affected consumers,
tests and existing cancellation patterns. The agent then opens complete symbols
and checks real call relationships. A small per-category result budget protects
tests and contracts from being crowded out, while an explicit all-match path is
needed for enumeration tasks.

**Find semantic variants during a migration.** For “Replace optimistic success
responses emitted before durable persistence,” enumerate the behavioral condition
without guessing API names. Verify each candidate's transaction boundary. Exact
search remains useful after concrete symbols have been discovered. The agent
should also inspect skipped paths before claiming a complete migration.

**Continuous review.** Once a condition proves useful on positive and negative
examples, promote it into a scoped, reviewed project rule. PR execution uses the
immutable base policy and reports incomplete evaluation. Do not automatically
turn an exploratory question into a merge-blocking rule or a deterministic lint.

The skill should route these tasks early, show one copyable command per route,
explain what leaves the machine, and tell the agent what to do with source ranges
and incomplete coverage. Detailed provider setup and configuration belong in
task-specific references. README needs the purpose, a minimal example, limits and
the skill link; it does not need the entire research narrative.

## Reproducible evaluation before claiming an improvement

Build a small, inspectable corpus before optimizing thresholds. Start with about
40–60 repository/query pairs spanning condition search and change preparation,
then expand once the annotation procedure is stable. This is an engineering pilot,
not enough data to claim universal accuracy.

Each case should commit or record:

- Repository URL and immutable commit, license, language and corpus exclusions.
- Exact query, intended task mode and independently reviewed positive/negative
  source ranges. For change tasks, label useful context separately from edited
  lines; an accepted patch is not a complete relevance oracle.
- Evidence requirements: local, boundary-spanning or cross-file. Include synonyms,
  misleading identifiers, nearby guards, multiple disjoint matches and relevant
  evidence placed near chunk boundaries.
- Natural queries with no relevant code, alongside explicit wrong-repository
  controls. Report abstention quality separately from positive-query retrieval.
- Expected source coverage, with unreadable/binary files, budget exhaustion,
  malformed answers and prompt-injection comments represented in adversarial
  cases. Failure accounting can be tested without claiming model quality.

Compare these arms against the same frozen cases:

| Arm | Purpose |
| --- | --- |
| Agent using `rg` and file reads | Actual workflow baseline; allow query reformulation rather than choosing a deliberately weak regex |
| Lexical/BM25 retrieval and an embedding retriever | Establish whether exhaustive scoring earns its additional latency and token cost |
| Hunch fixed windows, all eligible windows scored | Main baseline, with at least three window sizes |
| Fixed windows with overlap or syntax boundaries | Isolate boundary/context effects |
| Exhaustive baseline plus bounded split/expand refinement | Test localization and reading-cost improvements without upstream pruning |
| Coarse-first pruning, explicitly experimental | Measure lost recall and true-positive children of negative parents directly |

Record candidate precision/recall, all-required-evidence recall, recall at a fixed
returned-token budget, false positives per thousand windows, and the downstream
agent's task success under the same tool/time budget. Also record API tokens,
requests including failures/retries, elapsed time and source-reading tokens.
Measure operational coverage separately from semantic recall. For negative-heavy
audits, precision/recall curves and false positives per repository are more useful
than accuracy alone.

Retain every raw score and its source window. Evaluate calibration with reliability
bins and Brier score only where a defined binary label exists. Fit thresholds on a
development split, then freeze them for held-out repositories; tune separately by
query mode and model revision. Do not treat the maximum of five facet probabilities
as a calibrated joint probability. For adaptive windows, measure parent/child
disagreement and whether context removal introduces false positives.

Pin Hunch, provider/model, prompts, source hashes, chunking parameters, result
limits and concurrency. Keep paired results by query and confidence intervals
clustered by repository rather than counting correlated chunks as independent
trials. Run repeats on a subset to measure variability. Store the raw artifacts and
label disagreements; use human adjudication for important discrepancies instead
of allowing the evaluated model to certify its own output.

Adopt an algorithm change only when it improves held-out evidence retrieval or
downstream success within the declared cost/latency budget. Tests with a fake Jev
adapter validate interfaces, source ranges, budgets and failure handling. They
cannot validate semantic quality, calibration or superiority to grep.
