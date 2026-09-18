# Deploy the GitHub App

Project consumers need only a committed config and an installed Hunch App. Operators do this setup once. The CLI requires none of this infrastructure.

## 1. Deploy on Vercel

Import `Kelbie/hunch`, choose **Other**, root directory `apps/github-app`, Node **22.x**, and enable files outside the root directory so the core workspace is included. Install with `cd ../.. && bun install --frozen-lockfile`. For CLI deployments from the repository root, use `vercel deploy --prod --local-config apps/github-app/vercel.json`. The included `vercel.json` declares a public webhook and a private queue consumer in `iad1`, with a 300-second worker limit. Vercel Queues is currently beta. Do not add deployment authentication in front of the GitHub webhook; its HMAC verification authenticates GitHub.

Gateway authentication uses Vercel OIDC automatically. Enforced zero data retention (Hunch’s default) requires Pro/Enterprise. On Hobby, that request receives HTTP 403; either use an eligible plan or explicitly choose `zeroDataRetention: false` after deciding your data policy. Hunch does not change this automatically. Enable AI Gateway for your Vercel team and fund credits or configure provider access as required by that account. Use `AI_GATEWAY_API_KEY` for CLI/Actions, obtained from the Gateway dashboard. Never commit it. Direct TypeSafe is optional: set `provider: "typesafe"` and `TYPESAFE_API_KEY`; guidance compilation still uses Gateway.

Connect an **Upstash Redis** database through Vercel Storage/Marketplace, with `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` available to production. Redis stores only short-lived lease keys, not source code. It serializes work for each PR. The lease is 360 seconds and the worker is limited to 300 seconds; change these together. Missing Redis access fails closed and the queue retries.

## 2. Register and install a GitHub App

In [GitHub App settings](https://github.com/settings/apps/new), create an App with a unique name, for example `hunch-your-name`:

- Homepage: your Hunch repository URL.
- Webhook URL: `https://YOUR-PRODUCTION-DOMAIN/api/webhook`.
- Webhook secret: generate a random secret in a password manager.
- Repository permissions: **Contents read**, **Issues read**, **Pull requests write**, **Checks write**, **Metadata read**. Issues read is required to subscribe to [issue-comment events](https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment). No contents write or Actions permission is needed.
- Leave redirect/callback and setup URLs empty, OAuth during installation and Device Flow unchecked; Hunch authenticates as the installation. Keep user-token expiration at its default.
- Subscribe to **Pull request** and **Issue comment** events. An issue_comment webhook for a PR is processed only for exact `/hunch recheck`; the worker verifies the sender's current write/maintain/admin access.
- Install on the repositories you want reviewed.

The [app.yml](../apps/github-app/app.yml) is a permission reference, not a file GitHub accepts as an upload. GitHub's manifest flow requires a JSON form POST and code exchange; the manual form above avoids an extra public credential-bootstrap endpoint.

Generate an App private key and add these production Vercel variables using the dashboard or secure stdin to `vercel env add`:

| Variable | Value |
|---|---|
| `GITHUB_APP_ID` | Numeric App ID |
| `GITHUB_PRIVATE_KEY` | Full PEM private key (literal newlines or escaped `\n`) |
| `GITHUB_WEBHOOK_SECRET` | The same secret configured on GitHub |
| `UPSTASH_REDIS_REST_URL` | Redis integration URL |
| `UPSTASH_REDIS_REST_TOKEN` | Redis integration token |

Redeploy after setting variables. Do not paste credentials into a PR or issue. The App's installation token is scoped to the specific repository for each job.

## 3. Configure a repository

Run `hunch init`, optionally install skills and run `hunch compile`, review and commit those files to the default branch. Then open a PR. Policy is always read from the immutable base SHA, so a PR cannot rewrite its own rules. A PR that first introduces Hunch is skipped until the config is on its base branch.

The App reviews ready/open PRs on opened, synchronize, reopened, ready_for_review and edited events. Draft PRs are skipped. It creates a `hunch` check with annotations and a commit-labelled conversation report. It updates its own existing report for a retried head. It never adopts a comment merely because somebody copied Hunch's marker into it.

## Recovery and verification

Verify these cases on a disposable repository after deployment:

1. A real signed webhook is accepted; a forged signature returns 401.
2. The queue consumer runs privately, obtains an installation token, and creates a real check/report using Jev.
3. A fork PR cannot change trusted base config, skill references or the lock used to judge it.
4. An overlapping update/recheck is serialized; an obsolete head is skipped/cancelled.
5. Provider failure produces a failed check and a queue retry. A low-confidence concern stays advisory.

A webhook receives 202 only after durable enqueue. **GitHub does not automatically redeliver failed webhooks.** If it receives 503 or a timeout, inspect the App's Recent deliveries and use Redeliver after fixing the cause. After successful enqueue, queue failure retries with bounded exponential delay. Messages expire after 24 hours; monitor queue failures/backlog and Vercel function errors. A timed-out worker may leave an in-progress check until a retry or explicit recheck; do not configure it as a required merge check before validating operational recovery.

The queue is at-least-once. A durable lease prevents concurrent publication within the enforced worker lifetime. GitHub writes are not transactional with Redis; rare network ambiguity can still duplicate an external write. Reports always label their reviewed head, so a final-write race with a push cannot falsely claim the new head was checked. Failed provider response bodies are never published.

## GitHub Actions

Use the App for external fork PRs. As a simpler alternative for trusted same-repository PRs, add an `AI_GATEWAY_API_KEY` Actions secret and this workflow by running `npx hunch init --github`.

The generated workflow pins `Kelbie/hunch@v0.2.0`, checks out the immutable base commit, and passes the base/head SHAs to the Action. Pin a reviewed full commit SHA for stronger supply-chain immutability. It skips drafts, forks and Dependabot events (which normally cannot access Actions secrets). It fails with a setup message when the API key is absent. Configuration must be on the PR base branch before the first review. Follow the [README](../README.md#get-pr-reviews-in-three-steps) for key creation and repository-secret setup.

The Action prints annotations and a job summary; it does not post a conversation comment. It reads all policy via Git from the immutable PR base and never overwrites the working tree. Do not run untrusted PR scripts with secrets or switch this example to `pull_request_target` while checking out/executing fork code.

This repository's self-review workflow uses a trusted base checkout and the current base's local Action. It announces when a model key is absent rather than fabricating an audit. Its ordinary CI tests/builds the proposed code separately without secrets.

## Publishing npm

The package is `@hunch/cli`; it is not published as part of local development. The `@hunch` organization must be owned or grant the publishing account access; an unpublished package name does not establish scope ownership. Authenticate an authorized npm maintainer, run `bun run check` and `node scripts/package-smoke.mjs`, then from `packages/cli` run `npm publish --access public`. `prepack` builds the artifact. The published package contains Node ESM, declarations and runtime dependencies; it has no workspace dependencies. Prefer npm trusted publishing/provenance when configuring a release pipeline.

## Build from source

```sh
bun install --frozen-lockfile
bun run check
node scripts/package-smoke.mjs
(cd packages/cli && npm pack --ignore-scripts)
```

Install the resulting `hunch-cli-0.2.0.tgz` in a consumer project. Bun is needed to build Hunch; the distributed CLI runs on Node 22+.
