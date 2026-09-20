# Hunch integration research

Researched 2026-09-18 against first-party documentation. This is an architecture research record, not evidence that a deployed integration or a paid API request has succeeded. Recommendations below are Hunch design decisions inferred from the cited contracts.

## What Jev actually does

Jev is TypeSafe AI's System One evaluation model. It evaluates explicit state against independent typed questions. It returns decisions and distributions rather than prose. Its documented interface has no search, filesystem, or tool execution mechanism. Hunch must assemble the evidence and render the report. Broad questions should be decomposed into focused judgments. [TypeSafe introduction](https://docs.typesafe.ai/introduction)

The direct contract is `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`, JSON containing `model`, `state`, and `questions`. State accepts text, objects, or arrays. Questions are `noul`, `choice`, or `score`; response entries use the same IDs. IDs are not shown to the model, so each instruction must state its full condition. Noul returns the probability of yes; choice returns an option and distribution; score returns a weighted level and distribution. Retry 429 and 529 with backoff; validate responses before making a decision. [HTTP API](https://docs.typesafe.ai/api)

The current pinned version is `jev-1.13.0`; `jev-latest` and `jev-preview` currently resolve to it. Direct pricing is $0.042 per million input tokens, with no output charge. Published limits are 1,200 requests/minute and 250,000 tokens/second, explicitly subject to change. There are **two context constraints**: state plus all questions must fit 64k tokens; state plus the longest question must fit 32k. Log the response's model identity and prefer an explicit version when calibrating thresholds. [Models](https://docs.typesafe.ai/models)

TypeSafe documents weaknesses in numeric precision, literal interpretation, indirection, irrelevant context, and adversarial content. Architecture conclusions requiring many files and reasoning steps are therefore an uncertain use case, even if the request fits the token window. A successful API call proves transport, not review quality. [Jev 1.13 limitations, reviewed September 17](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

**Recommendation:** use Jev for bounded evidence-backed heuristics. Report a suspected violation, not a proven defect. Author a helpful rule message, attach the actual diff location, and show the evaluated question. Do not manufacture a model explanation or pretend a short hunk proves repository-wide architecture compliance. Counting, formatting, type correctness, forbidden tokens, and regex-only checks belong in existing deterministic tools.

## Vercel API access

AI Gateway's documented evaluation route is the AI SDK, **version 7 or later**, using `experimental_evaluate`. It is not supported through Gateway's OpenAI-, Anthropic-, or Cohere-compatible endpoints. The model string is `typesafe-ai/jev`. The SDK calls a yes/no question `boolean` and returns `probability`; the direct API calls it `noul`. Choice and score expose distributions. Hide this translation behind one evaluator interface. [Evaluation documentation](https://vercel.com/docs/ai-gateway/modalities/evaluation)

```ts
import { experimental_evaluate as evaluate } from 'ai';

const result = await evaluate({
  model: 'typesafe-ai/jev',
  state: { diff: patch, reference: relevantGuidance },
  questions: {
    violation: {
      type: 'boolean',
      instructions: 'Does the added code in `diff` violate the specified rule in `reference`?',
    },
  },
  providerOptions: { gateway: { zeroDataRetention: true } },
});
```

For a CLI or GitHub Actions runner, create an AI Gateway key in Vercel's AI Gateway API Keys dashboard and expose it as `AI_GATEWAY_API_KEY`. The CLI command is `vercel ai-gateway api-keys create --name hunch`. Keys can have budgets and expiry. Keep the key in the local process environment or GitHub secret, never the repository config. [API key setup](https://vercel.com/docs/ai-gateway/authentication-and-byok/api-keys)

On Vercel, prefer automatic project OIDC when no API key is set. Local OIDC development requires `vercel link` and `vercel env pull`; downloaded tokens expire after 12 hours. An arbitrary `VERCEL=1` environment variable is not proof of usable authentication. [OIDC](https://vercel.com/docs/ai-gateway/authentication-and-byok/oidc)

Gateway lists Jev at $0.04 per million input tokens. Its public model identifier is unversioned; no pinned Gateway Jev identifier was established by this research. Do not imply that Hunch's direct-provider model setting pins Gateway's backend version. [Jev model page](https://vercel.com/ai-gateway/models/jev)

Gateway documents `providerOptions.gateway.zeroDataRetention: true` and lists TypeSafe AI as supporting ZDR and no prompt training. This filters routing and fails if no compliant provider is available. It is a Gateway routing policy, not a magic retention flag for TypeSafe's direct endpoint. State exactly which route was used; account/provider contracts and legal exceptions still apply. [Gateway ZDR](https://vercel.com/docs/ai-gateway/security-and-compliance/zdr)

TypeSafe's `confidence` for choice and score is a statistic over the distribution, with no exact formula specified on its confidence page. If Hunch computes a different statistic, label it as Hunch's certainty measure and document it. Never replace a missing distribution with a one-hot distribution: that invents certainty. [Confidence](https://docs.typesafe.ai/confidence)

If guidance compilation uses a separate text-generating model, `anthropic/claude-sonnet-5` is a valid Gateway model today. Compilation incurs separate usage and is not a Jev capability. [Sonnet 5 model page](https://vercel.com/ai-gateway/models/claude-sonnet-5)

## Credentials for a CLI run anywhere (2026-09-20)

Until 0.15.0 the CLI found credentials only in the process environment, in `.env` files in the working directory, or through a `.vercel/project.json` in or above it. A person who authenticated by `vercel link` and had no key could therefore run Hunch in exactly one directory, and an agent running it elsewhere met the AI SDK's "No authentication provided".

What comparable tools do:

- **One per-user file, written by a login command.** `gh auth login` keeps tokens in the system credential store and falls back to plain text in `~/.config/gh/hosts.yml`; `--with-token` reads the token from standard input. [gh auth login](https://cli.github.com/manual/gh_auth_login) The Stripe CLI writes `~/.config/stripe/config.toml` from `stripe login`. [Stripe CLI login](https://docs.stripe.com/cli/login) npm keeps `_authToken` in the per-user `~/.npmrc`. [npmrc](https://docs.npmjs.com/cli/configuring-npm/npmrc) AWS reads `~/.aws/credentials`. [AWS CLI files](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html)
- **Location.** `$XDG_CONFIG_HOME`, defaulting to `~/.config`. [XDG Base Directory](https://specifications.freedesktop.org/basedir-spec/latest/)
- **Precedence.** Environment variables override the stored file in gh, AWS and npm, so CI and per-project overrides keep working.
- **No secret in argv.** Arguments are visible in process listings and saved in shell history; gh and `docker login --password-stdin` take secrets on standard input for that reason. [docker login](https://docs.docker.com/reference/cli/docker/login/)

Hunch follows that: `hunch auth login` writes `~/.config/hunch/credentials` (mode 0600, directory 0700), read after the environment and the project's `.env` files. An OS keychain was not used: it needs a native dependency, which `npx` installs cannot rely on, and gh itself falls back to a file. Only `AI_GATEWAY_API_KEY` and `TYPESAFE_API_KEY` are ever exported from the file, so editing it cannot inject `NODE_OPTIONS` or a proxy.

For keyless Vercel users, `@vercel/oidc` 3.2.0 (the version `@ai-sdk/gateway` 4.0.85 depends on) accepts `getVercelOidcToken({ project, team })` and then mints a token from the Vercel CLI login without reading `.vercel/project.json`; this was read in the installed source, and the token is left in `VERCEL_OIDC_TOKEN`, which the Gateway provider reads first. `hunch auth login --vercel` stores only the project and team ids and mints per run. Verified live on 2026-09-20: a `check` completed from a directory with no `.env` and no `.vercel`, using only the stored project. Not verified: Windows paths, and a Vercel CLI that keeps its login in the system keyring (newer `@vercel/oidc` versions shell out to `vercel project token` for that case; 3.2.0 does not).

## Skills and repository guidance

The Agent Skills specification defines a directory containing `SKILL.md` with YAML metadata and Markdown instructions. It permits additional resources and describes progressive loading. It does not define a universal GitHub shorthand resolver, review policy language, or arbitrary-script execution requirement. Hunch should consume bounded text; a linked script is not authorization to execute it. [Agent Skills specification](https://agentskills.io/specification)

The established `skills` installer supports `owner/repo`, full GitHub repository URLs, and URLs to individual skill directories, with `--skill` selection. Its canonical `.agents/skills/` directory is used by Codex and many other agents. Prefer this installer over building another package manager. The owner/repo spelling is an installer convention, not part of the Agent Skills specification. [Skills CLI](https://github.com/vercel-labs/skills)

```sh
npx skills add mattpocock/skills --skill codebase-design --agent codex --yes
```

Commit the installed skill and installer lockfile. Hunch should read `.agents/skills/<name>/SKILL.md` from the reviewed policy revision; remote URLs are provenance and installation input, not something the PR reviewer silently fetches on every run. Resolve and hash any explicitly included reference documents too. Path containment, symlink handling, UTF-8 byte limits, and missing-file errors must be deliberate.

Matt Pocock's `codebase-design` describes depth through caller leverage and maintainer locality, not line counts. Its deletion test asks whether removing a module removes complexity or scatters it across callers. These are suitable review topics when the supplied evidence includes enough implementation and callers. Merely looking for words like “interface” or limiting module size does not implement the skill. [Source skill](https://github.com/mattpocock/skills/blob/main/skills/engineering/codebase-design/SKILL.md)

`AGENTS.md` is plain Markdown, can exist at the root and nested package paths, and the closest applicable file takes precedence. Hunch should preserve scope when deriving review rules. Commands in that file are context for coding agents; Hunch's review worker should not execute repository instructions. [AGENTS.md convention](https://agents.md/)

**Recommendation:** explicit plain-English rules are the first-class product. Skills and scoped `AGENTS.md` supply supporting guidance. If compiling guidance, do it explicitly, commit a reviewable artifact with source paths and hashes, and flag stale artifacts. A lossy compiler must never claim every instruction was enforced. If a rule needs unavailable callers or whole-repository evidence, skip it with an explanation instead of guessing.

## Config and language support

TypeScript configuration is familiar in the JavaScript ecosystem; Vite, for example, supports a typed config file and `defineConfig`. This is evidence of a common pattern, not proof of one universal community preference. [Vite configuration](https://vite.dev/config/)

Rust's Cargo manifest uses TOML. A standalone `hunch.toml` is therefore a reasonable Rust default without adding Node-style configuration to Rust source. An npm CLI can review Rust or other text diffs without the target project adopting TypeScript. [Cargo manifest format](https://doc.rust-lang.org/cargo/reference/manifest.html)

**Recommendation:** one schema, two encodings: a restricted declarative `hunch.config.ts` and `hunch.toml`. Reject ambiguous multiple configs. Never import or execute PR-controlled TypeScript in a privileged worker; parse supported literal syntax or consume a validated policy artifact. Avoid supporting numerous aliases, dynamic imports, arbitrary helper functions, and multiple independent config merge systems. Explain the supported static subset rather than presenting it as arbitrary TypeScript execution.

## GitHub App and durable Vercel execution

GitHub expects a 2xx webhook response within ten seconds. Check event type/action, use minimal subscriptions, and record `X-GitHub-Delivery`; a redelivery retains that ID. [Webhook practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)

Validate HMAC-SHA256 over the original request bytes using `X-Hub-Signature-256` before parsing or enqueueing. Keep the secret server-side and compare signatures safely. [Webhook validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)

The prototype's `waitUntil(runReview(...))` is insufficient for durable delivery: Vercel says those promises share the function timeout and are cancelled when it expires. Returning “queued” before persisting work makes a failure invisible to GitHub. [Vercel function helpers](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package)

Use Vercel Queues for this bounded review worker. The product is beta and offers at-least-once delivery; processing can repeat and ordering is not strict. Workflow is the higher-level alternative when work grows into a stateful sequence of durable steps. The queue does not replace idempotent side effects. [Queues concepts](https://vercel.com/docs/queues/concepts)

Minimal integration:

1. Verify and validate the webhook.
2. Await `send('hunch-reviews', job, { idempotencyKey: deliveryId })` before returning 202.
3. Route the topic to a private queue-triggered function.
4. Let failed transient work throw so the queue retries.

The quickstart requires Node 22+ and `@vercel/queue`. It uses `handleCallback` for Web Request handlers, automatic OIDC on deployment, and `experimentalTriggers` in `vercel.json`. The trigger makes the consumer private. Local testing uses `vercel dev`. [Queue quickstart](https://vercel.com/docs/queues/quickstart)

```json
{
  "functions": {
    "api/review.ts": {
      "experimentalTriggers": [
        { "type": "queue/v2beta", "topic": "hunch-reviews" }
      ]
    }
  }
}
```

`handleCallback` acknowledges completed handlers and retries thrown errors. Its retry callback accepts `{ afterSeconds }` or `{ acknowledge: true }`; the latter stops retries and must follow a deliberate terminal-failure policy. The SDK renews its default five-minute visibility lease. Classic Node request/response handlers instead use `QueueClient.handleNodeCallback`. The npm registry returned `@vercel/queue` 0.6.0 during research. [Queue SDK](https://vercel.com/docs/queues/sdk), [registry metadata](https://registry.npmjs.org/@vercel%2fqueue/latest)

**Recommendation:** put only installation/repository/PR/revision identifiers in the job, fetch policy from the trusted base revision, and evaluate the immutable requested head. Recheck the head before publishing. Use installation-scoped credentials and minimal permissions. Key reports by repository, PR, head SHA, and policy hash; do not rely on an in-memory Set. A sticky comment must be found by authenticated app identity as well as a marker, and concurrent retries must not duplicate or overwrite newer output. An incomplete or failed review must never become a green “no findings” check.

GitHub does **not** automatically retry failed webhook deliveries. A durable queue protects only events that reached it successfully. Provide a documented manual redelivery procedure or scheduled GitHub App delivery recovery; otherwise “every PR” remains a best-effort promise during ingress outages. [Failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)

## Validation still needed

- An authenticated Jev evaluation through each supported provider, including the installed SDK's real response shape and Gateway model identity.
- A labeled corpus of good and bad TypeScript/Rust changes to measure false positives, false negatives, evidence insufficiency, and chosen thresholds.
- Deployed webhook signature verification, queue retries, duplicate delivery, stale-head suppression, and authenticated report ownership.
- A real GitHub App installation and PR comment/check cycle. Local unit tests cannot establish installation permissions or hosted reliability.
- Current account quotas, billing, retention settings, and beta queue availability. Published limits are snapshots; older queue pages disagree about maximum retention, so avoid depending on the upper bound without checking the deployed API.

These are explicit remaining verification categories, not claims that the current implementation has or has not completed them.

## Live verification supplement (2026-09-18)

The current account's Hobby plan rejected per-request enforced ZDR with HTTP 403. A synthetic public sentence (no repository content) succeeded through Gateway OIDC with ZDR explicitly disabled, returning model `typesafe-ai/jev`, boolean probability `0.99`, and 287 input tokens. Production defaults remain ZDR-on. This verifies authentication and the boolean wire contract, not review quality or deployment readiness. Vercel's current product guidance confirms per-request ZDR is Pro/Enterprise-only: [secure AI Gateway controls](https://vercel.com/i/secure-ai-gateway).

A follow-up synthetic request verified all three Gateway primitives together: boolean `0.99`, choice `blue` with `{red:0, blue:1}`, and score `1` with `{0:0, 1:1}`. It consumed 381 input tokens. `scripts/live-smoke.ts` reproduces this contract check with explicit privacy settings.
