# hunch install

`hunch.lock` is the policy a review applies: every rule that is not written in the config itself.
`install` writes it from two kinds of source, and they are treated differently on purpose.

| Source | Needs an agent? | Why |
| --- | --- | --- |
| rule packs the config names | no | a pack is already written as rules, so it is copied verbatim and pinned to a commit |
| Agent Skills, `AGENTS.md`, `docs` | yes | prose written for coding agents has to be converted into short typed questions |

Reviews read the lock. They never run the compiler, never fetch a pack and never fetch a remote
skill. Real output: [examples/install.md](../examples/install.md). Flags:
[cli.md](cli.md#hunch-install).

```sh
npx -y --min-release-age=0 @kelbie/hunch install --dry-run
npx -y --min-release-age=0 @kelbie/hunch install --with claude
```

`compile` and `i` are aliases, so an older command line still works.

## Packs

The config names them; [packs.md](packs.md#packs-in-the-config) covers the selection syntax and
[config.md](config.md#every-option) the `packs` option.

```ts
packs: ["nuts-spec", { pack: "bips-spec", rules: ["bip32/*", "bip340/*"] }],
```

Each pack becomes one entry under `packs` in the lock, holding the rules **as their author wrote
them**: the same question, the same threshold, the same `files` scope, and the same level, so a pack's
`error` stays an error. The entry also records the pack's spec, the commit it was copied from, the
sha256 of the file, and the id patterns selected. A pack rule can still be re-levelled or switched
off from the config by id or glob, and replaced outright by writing a rule with the same id.

`install` re-copies every pack each time it runs, so it picks up an upstream change the way `npm
install` picks up a new version. Pin a tag or commit (`nuts-spec@v2`, `owner/repo/name@<sha>`) for a
policy that must not move. `--packs-only` refreshes the packs and leaves the compiled rules alone,
which needs no agent at all.

A selection pattern that matches no rule in the pack is an error, not an empty selection: a mistyped
id would otherwise review nothing while the run still looked complete.

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
| see what would change first | `install --dry-run` (`new`, `changed`, `unchanged`, `removed`) |
| packs only, no guidance to compile | `install` — no agent is asked for |
| refresh the packs, keep the compiled rules | `install --packs-only` |
| an agent, with Claude Code installed | `install --with claude` (add `--effort low\|medium\|high\|xhigh\|max`) |
| with Codex | `install --with codex` |
| no local coding agent | `install --with gateway` (uses `compileModel` and `AI_GATEWAY_API_KEY`) |
| recompile everything | `--force` |
| a person at a terminal | `install`, which asks which agent and effort |

Without a terminal and without `--with`, it reuses the compiler recorded in `hunch.lock`, or fails
asking for `--with`. Claude Code runs with no tools and no settings files, and Codex in its read-only
sandbox. Both run in an empty temporary directory and must return schema-valid rules.

Only changed guidance is compiled. Each source's text is hashed into `hunch.lock`, and a source
whose hash still matches keeps its reviewed rules untouched. A remote skill is pinned to a commit,
but the pin alone decides nothing: when upstream moves on and the skill's text is the same, the lock
takes the new commit and keeps the rules. Two things recompile everything: `--force`, and choosing a
different compiler or effort than the one recorded in the lock, since rules from two compilers would
sit under one recorded identity. `install --dry-run` shows which sources would be compiled.

## After installing

1. **Read `hunch.lock` before committing it.** It is the policy that will review PRs. For compiled
   rules the compiler can lose nuance, misplace scope, or infer the wrong globs; for packs it is
   someone else's rules now running on your code. Each source records its path, hash, rules
   (`id`, `instructions`, `criteria`, `appliesTo`, `message`) and `notChecked`; each pack records its
   commit and its rules.
2. `notChecked` lists guidance that can't be judged one change at a time, such as "run the tests"
   or "discuss big changes first". It is reported as a limitation, never silently dropped. It is a
   record of what the compiler left out and why, not a fault: a review with `notChecked` entries is
   still complete. Read it for guidance that was dropped wrongly, reword that guidance so one chunk
   can show a violation, and install again.
3. `appliesTo` and `when` on a compiled rule are the compiler's guess at where the rule matters. A
   wrong guess silences the rule. Set `review.compiledScope: "everywhere"`
   ([config.md](config.md#review-context)) to ask every compiled rule of every chunk instead. Pack
   rules carry their author's own `files`, which is not a guess and is left alone.
4. `hunch config` lists every rule together, packs included, with `pack:<owner/repo/name>` as the
   source. Tune or silence them by id or glob: `"skill/api-style/*": "off"`, `"nut11/*": "warn"`,
   `"agents-md/root/no-secrets": "error"`.
5. Check `budget.maxRulesPerHunk` against the rule count. A large specification pack can define more
   rules than the default 24 allowed per chunk, and `install` says so when it does; the rest are
   reported as skipped rather than asked.
6. Commit `hunch.lock` to the default branch with the config.

## Staleness

When a selected source changes — an edited `AGENTS.md`, a new skill, a changed `skills` list, a pack
added, dropped, re-pinned or re-selected — the lock goes stale. `hunch config` exits 2 and names
what is stale; `check` still runs but marks the review incomplete. Run `install` deliberately: a
remote skill update and an upstream pack change are only picked up that way.
