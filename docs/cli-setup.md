# Set up the GitHub App from your terminal

This is the operator setup for bot comments, fork PRs, and multiple repositories. For Actions checks only, use the [three-step install](../README.md#get-pr-reviews-in-three-steps).

Use Node 22+, Bun 1.3.5+, GitHub CLI and a local macOS/Linux terminal. GitHub still requires browser confirmation of App registration and repository installation; Vercel may require Marketplace terms. Everything else below runs through the CLI. The hosted App authenticates to AI Gateway with Vercel OIDC: **no model API key to copy into repositories**. Gateway credits/quota must be available on your team.

## 1. Deploy the backend

Run from a fresh Hunch checkout. Replace `YOUR_VERCEL_TEAM` and choose an unused project name:

```sh
gh auth login
gh repo clone Kelbie/hunch
cd hunch
bun install --frozen-lockfile
bun run build
npm install --global vercel@59.23.0
vercel login

export HUNCH_TEAM=YOUR_VERCEL_TEAM
export HUNCH_PROJECT=hunch-reviews
vercel project add "$HUNCH_PROJECT" --scope "$HUNCH_TEAM"
vercel api "/v9/projects/$HUNCH_PROJECT" --method PATCH --scope "$HUNCH_TEAM" \
  --field rootDirectory=apps/github-app --field sourceFilesOutsideRootDirectory=true \
  --field nodeVersion=22.x --silent
vercel link --yes --project "$HUNCH_PROJECT" --scope "$HUNCH_TEAM"
vercel deploy --prod --yes --scope "$HUNCH_TEAM" --local-config apps/github-app/vercel.json
```

Use the stable **Aliased** production domain from the output, not the per-deployment URL:

```sh
export HUNCH_URL=https://YOUR-PRODUCTION-DOMAIN.vercel.app
```

The public webhook must be reachable without Vercel Deployment Protection. Hunch validates GitHub's signature itself. `/api/health` initially reports `setup_required`; the queue worker is deliberately not publicly callable. Do not choose a frontend framework for this project.

## 2. Add the lease database

```sh
vercel integration add upstash/upstash-kv --name hunch-leases --plan free \
  -m primaryRegion=iad1 -m autoUpgrade=false -m prodPack=false \
  -e production --no-env-pull --scope "$HUNCH_TEAM" \
  --local-config apps/github-app/vercel.json
```

If Vercel returns a terms-acceptance link, open it, accept, and rerun. If the command's outcome is uncertain, inspect `vercel integration list -i upstash --scope "$HUNCH_TEAM"` before creating another resource. The successful command connects Redis and supplies the production `KV_REST_API_URL`/`KV_REST_API_TOKEN` pair automatically. No credential copying. Redis holds short-lived PR locks; source code is not stored there. Free-tier limits still apply.

## 3. Register and connect the App

```sh
node packages/cli/dist/bin.js app register --name YOUR-UNIQUE-APP-NAME \
  --webhook-url "$HUNCH_URL/api/webhook"
```

Open the printed local URL in a browser **on the same computer** and confirm on GitHub. Add `--organization YOUR_ORG` when registering for an organization. The manifest sets the required permissions, event subscriptions and webhook URL. It creates a private App owned by you and returns the App ID to the terminal. Keep the command running until it finishes.

```sh
node packages/cli/dist/bin.js app connect --app-id YOUR_APP_ID \
  --webhook-url "$HUNCH_URL/api/webhook" \
  --vercel-project "$HUNCH_PROJECT" --scope "$HUNCH_TEAM"
vercel deploy --prod --yes --scope "$HUNCH_TEAM" --local-config apps/github-app/vercel.json
```

Open the printed **Install** link and select the repositories to review. Check `/api/health`: both `githubApp` and `leaseStore` should be `true`. That confirms configuration presence; the first real PR confirms access and model availability.

**Existing App?** Skip registration. On the first `app connect`, add `--private-key /absolute/path/to/app.pem`, using its numeric App ID. Hunch validates permissions, generates and saves a webhook secret, uploads the three production App variables, and updates GitHub's webhook configuration. Enable **Pull request** and **Issue comment** events in the existing App's settings if the command reports them missing. This changes that App's webhook; use an App dedicated to Hunch.

Credentials are saved outside the repo at `~/.config/hunch/apps/APP_ID.json` with private file permissions. They are sent to Vercel over stdin and never printed. Keep this file private and backed up. Rerunning `app connect` resumes with the same secret; it refuses a changed webhook or key. Reconnection/redeployment is required after intentional credential rotation. Avoid updating a live App during active reviews.

## 4. Enable reviews on each repository

From the repository you want reviewed:

```sh
npm install -D @kelbie/hunch
npx hunch init
# If using skills or AGENTS.md: set AI_GATEWAY_API_KEY locally, then npx hunch compile
```

Use `--rust`, `--ts`, or `--general` to choose the preset explicitly. Commit the config and any reviewed `hunch.lock` to the PR base branch. You don't need `--github` or an Actions model secret when using the App.

**Choose your data policy before the first review.** Enforced zero data retention is on by default and requires an eligible Vercel plan. For Hobby, explicitly set `zeroDataRetention: false` in TypeScript or `zero-data-retention = false` in TOML only if that matches your policy. Hunch never silently opts out.

Open a non-draft PR. The App adds a `hunch` check and a conversation report. To review an existing PR after setup, a repository writer can run:

```sh
gh pr comment PR_NUMBER --body '/hunch recheck'
```

If no report arrives, check App installation/repository selection, event subscriptions, Recent deliveries, then Vercel function logs and Gateway quota. A delivery is accepted only after durable enqueue; GitHub does not automatically retry rejected deliveries. [Operations and recovery](deploy.md#recovery-and-verification).

The `app connect` path was exercised against the Hunch deployment. New-App registration is tested through the local callback flow with a simulated GitHub exchange; that is not a claim of a second live App registration. See [verified status](status.md) for the end-to-end evidence.

Primary references: [GitHub manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest), [Vercel CLI integrations](https://vercel.com/docs/cli/integration), [Vercel project settings API](https://vercel.com/docs/rest-api/projects/update-an-existing-project).
