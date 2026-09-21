# hunch doctor

"I opened a PR and Hunch said nothing." `doctor` checks, in order, the things that make that happen,
using the `gh` login. Real output: [examples/doctor.md](../examples/doctor.md).

| Check | Fails when | Fix it prints |
| --- | --- | --- |
| Config in working tree | no `hunch.config.ts` or `hunch.toml` locally | `npx -y --min-release-age=0 @kelbie/hunch init` |
| GitHub remote | `origin` isn't on github.com (the check is then unknown, and doctor stops) | only local review applies |
| Repository access | `gh` can't read the repository | `gh auth login` |
| Config on `<default branch>` | the config isn't on the default branch, where reviews read it | commit and merge it |
| App installed | the App (`--app`, default `hunch-review`) isn't installed for the owner | the install link |
| App owner | a private App owned by someone else can't be installed here | install the hosted App, or register a public/organisation App |
| Actions workflow | no `.github/workflows/hunch.yml` (unknown; needed only for Actions) | `init --target actions` |
| Actions secret | the workflow exists but `AI_GATEWAY_API_KEY` isn't a repository secret | `gh secret set AI_GATEWAY_API_KEY` |

"Repository access" and "App owner" only appear when they are a problem; a healthy repository shows
six lines.

Anything doctor can't establish is `?` (unknown), never `✓`. A `?` for "App installed" usually means
the `gh` token can't list installations, not that the App is missing. Say so to the user rather than
treating it as a failure.

`--reporter json` gives `{ checks: [{ label, status: "ok"|"bad"|"unknown", detail, fix? }], failed }`.
Exit code 1 when any check is `bad`.

If doctor passes and there is still no review:

- the PR is a draft (the App skips drafts; so does the generated workflow);
- it is the PR that adds Hunch (skipped by design);
- on Actions, the PR comes from a fork (no secrets);
- the provider failed. The check run on the PR says so; comment `/hunch recheck` to retry.
