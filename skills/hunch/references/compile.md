# hunch compile

Agent Skills and `AGENTS.md` are written for coding agents as long prose. Jev answers only short
typed questions. `compile` converts the guidance once, with a coding agent or a Gateway model, and
writes the resulting questions to `hunch.lock`. Reviews read the lock. They never run the compiler
and never fetch remote skills. Real output: [examples/compile.md](../examples/compile.md). Flags:
[cli.md](cli.md#hunch-compile).

## What gets compiled

The config selects it; see [config.md](config.md#guidance).

| Source | Selected by | Lock id |
| --- | --- | --- |
| installed skills (`.agents/skills/*`, `.claude/skills/*`) | `skills` omitted (all), or listed | `skill/<name>` |
| remote skills | `skills: ["owner/repo"]` or `{ repo, skill, ref }` | `skill/<name>`, with the resolved commit |
| root and nested `AGENTS.md` | `agentsMd: true` (default) | `agents-md/root`, `agents-md/<dir>` |
| other docs | `docs: ["docs/style.md"]` | `doc/<path>` |

Nested `AGENTS.md` inherit their ancestors: each directory's guidance includes the parents', with the
nearer file winning. A file is governed only by the deepest applicable compiled AGENTS source. The
combined text must fit 40 KB.

`agentsMd` is on by default, so an `AGENTS.md` needs no config change. It is ignored until it is
compiled. `hunch config` reports it as missing from `hunch.lock` until then.

## Running it

| Situation | Command |
| --- | --- |
| see what would change first | `compile --dry-run` (`new`, `changed`, `unchanged`, `removed`) |
| an agent, with Claude Code installed | `compile --with claude` (add `--effort low\|medium\|high\|xhigh\|max`) |
| with Codex | `compile --with codex` |
| no local coding agent | `compile --with gateway` (uses `compileModel` and `AI_GATEWAY_API_KEY`) |
| recompile everything | `--force` |
| a person at a terminal | `compile`, which asks which agent and effort |

Without a terminal and without `--with`, it reuses the compiler recorded in `hunch.lock`, or fails
asking for `--with`. Claude Code runs with no tools and no settings files, and Codex in its read-only
sandbox. Both run in an empty temporary directory and must return schema-valid rules. Unchanged
sources are reused only if the compiler identity is the same.

## After compiling

1. **Read `hunch.lock` before committing it.** It is the policy that will review PRs, and the compiler
   can lose nuance, misplace scope, or infer the wrong globs. Each source records its path, hash,
   rules (`id`, `instructions`, `criteria`, `appliesTo`, `message`) and `notChecked`.
2. `notChecked` lists guidance that can't be judged one change at a time, such as "run the tests"
   or "discuss big changes first". It is reported as a limitation, never silently dropped.
3. `hunch config` lists the compiled rules alongside the rest. Tune or silence them by id or glob:
   `"skill/api-style/*": "off"`, `"agents-md/root/no-secrets": "error"`.
4. Commit `hunch.lock` to the default branch with the config.

## Staleness

When a selected source changes (an edited AGENTS.md, a new skill, a changed `skills` list), the
lock goes stale. `hunch config` exits 2 and names the stale sources; `check` still runs but marks the
review incomplete. Re-run `compile` deliberately: remote skill updates are only picked up that way.
