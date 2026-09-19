#!/usr/bin/env bun
/**
 * Writes skills/hunch/examples/*.md from real runs of the CLI, the way terminal-shot.mjs makes the
 * README's images: nobody types expected output by hand, so it cannot describe a CLI that no longer
 * exists.
 *
 *   bun scripts/skill-examples.ts           offline cases: dry runs, config, init, errors
 *   bun scripts/skill-examples.ts --live    also the cases that call Jev, gh or a compiling agent
 *   bun scripts/skill-examples.ts --check   fail if an offline case's output has changed
 *
 * Live cases are kept from the existing file when not re-run, stamped with the version and date
 * they were captured, because they cost money and depend on a model that changes.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../packages/cli/src/version.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(root, "packages/cli/src/bin.ts");
const OUT = join(root, "skills/hunch/examples");
const live = process.argv.includes("--live");
const checking = process.argv.includes("--check");

// ---------------------------------------------------------------------------------------------
// A small shop repository: the same one every example runs against, so outputs agree.

const SHOP_CONFIG = `import { choice, defineConfig, noul, score } from "@kelbie/hunch";

export default defineConfig({
  extends: ["hunch:recommended", "hunch:typescript"],
  include: ["src/**"],
  // No guidance to compile; see compile.md for a shop that has some.
  agentsMd: false,
  skills: [],
  rules: {
    // Plain English: flagged when a change likely breaks the sentence.
    "api/stable-errors": ["error", "Error responses keep their code field, because clients branch on it."],

    // noul: a yes/no question, flagged when P(yes) >= threshold.
    "tests/weakened": ["warn", noul({
      instructions: "Does \`hunk\` remove or loosen an assertion without adding an equivalent check?",
      criteria: { true: "An assertion is deleted or made looser.", false: "Assertions are unchanged, stricter or only renamed." },
      threshold: 0.8,
      files: ["**/*.test.ts"],
      when: /expect|assert/,
      message: "A test may have been weakened.",
    })],

    // choice: Jev picks one label; labels in \`report\` are flagged.
    "payments/retry-safety": ["error", choice({
      instructions: "If the payment call in \`hunk\` is retried, what happens to the customer?",
      criteria: {
        "safe": "Retries reuse the same idempotency key, so the customer is charged once.",
        "duplicate-charge": "A retry can charge the customer again.",
        "not-applicable": "The change does not retry a payment.",
      },
      report: ["duplicate-charge"],
      minConfidence: 0.5,
      files: ["src/payments/**"],
      reference: "docs/contracts.md",
      message: "A retry may charge the customer twice.",
    })],

    // score: ordered levels, worst to best; flagged below reportBelow (0 to 1).
    "tests/specific": ["warn", score({
      instructions: "How precisely do the tests changed in \`hunk\` pin down the behavior they cover?",
      criteria: [
        "They only check that the code runs without throwing.",
        "They check broad properties, such as a result being defined.",
        "They check exact outputs for the main case.",
        "They check exact outputs, including edge cases and failures.",
      ],
      reportBelow: 0.5,
      files: ["**/*.test.ts"],
    })],

    "docs/contradictory-comment": "off",
  },
  overrides: [{ files: ["src/scripts/**"], rules: { "api/stable-errors": "off" } }],
  zeroDataRetention: false,
});
`;

const SHOP_BASE: Record<string, string> = {
  "package.json": `{ "name": "shop", "private": true, "type": "module" }\n`,
  "AGENTS.md": "# Shop\n\nNever log card numbers or CVCs, even partially.\nRun `bun test` before committing.\n",
  ".agents/skills/api-style/SKILL.md": "---\nname: api-style\ndescription: How this shop's HTTP API reports errors.\n---\n\nEvery error response is `{ code, message }`. `code` is stable and machine-readable; clients switch on it. Never reuse a code for a different failure.\n",
  "docs/contracts.md": "# Payment contract\n\nA charge is retried at most three times. Every attempt for one order reuses the order's idempotency key, so the gateway returns the original charge instead of creating another.\n",
  "src/payments/charge.ts": `export async function charge(gateway: Gateway, order: Order) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await gateway.charge({ amount: order.total, idempotencyKey: order.id });
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
}
`,
  "src/api/errors.ts": `export function notFound(resource: string) {
  return { status: 404, body: { code: "not_found", message: \`\${resource} was not found\` } };
}
`,
  "src/api/errors.test.ts": `import { expect, test } from "bun:test";
import { notFound } from "./errors";

test("not found keeps its code", () => {
  expect(notFound("order").body).toEqual({ code: "not_found", message: "order was not found" });
});
`,
};

/** The feature branch every `check` example reviews: a retry that mints a new key, and a looser test. */
const SHOP_CHANGE: Record<string, string> = {
  "src/payments/charge.ts": `export async function charge(gateway: Gateway, order: Order) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await gateway.charge({ amount: order.total, idempotencyKey: crypto.randomUUID() });
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
}
`,
  "src/api/errors.test.ts": `import { expect, test } from "bun:test";
import { notFound } from "./errors";

test("not found keeps its code", () => {
  expect(notFound("order").body).toBeDefined();
});
`,
};

function write(dir: string, files: Record<string, string>) {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
}

function git(dir: string, ...args: string[]) {
  const r = spawnSync("git", ["-c", "user.name=Shop", "-c", "user.email=shop@example.invalid", ...args], { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

/** A git repository with `files` committed on main, and optionally `change` committed on `feature`. */
function repo(files: Record<string, string>, change?: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "hunch-example-"));
  write(dir, files);
  git(dir, "init", "--quiet", "-b", "main");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "base");
  if (change) {
    git(dir, "switch", "--quiet", "-c", "feature");
    write(dir, change);
    git(dir, "add", ".");
    git(dir, "commit", "--quiet", "-m", "change");
  }
  return dir;
}

const shop = () => repo({ ...SHOP_BASE, "hunch.config.ts": SHOP_CONFIG }, SHOP_CHANGE);
/** The same shop, compiling its skill and AGENTS.md into hunch.lock. */
const GUIDED_CONFIG = SHOP_CONFIG.replace(/  \/\/ No guidance[^\n]*\n  agentsMd: false,\n  skills: \[\],/, '  agentsMd: true,\n  skills: ["./.agents/skills/api-style"],');
const guidedShop = () => repo({ ...SHOP_BASE, "hunch.config.ts": GUIDED_CONFIG }, SHOP_CHANGE);

// ---------------------------------------------------------------------------------------------

interface Case {
  id: string;
  title: string;
  /** What the example shows, in a sentence, for an agent choosing which one to read. */
  note?: string;
  /** The command as a person would type it, without `npx @kelbie/hunch`. */
  args: string[];
  setup: () => string;
  /** Needs a model key, gh or a compiling agent. */
  live?: boolean;
  /** What a live case needs, in words, for the placeholder shown until it is captured. */
  needs?: string;
  /** Files to print after the run, from the repository it ran in. */
  show?: string[];
  env?: Record<string, string>;
}

interface Page { file: string; title: string; intro: string; cases: Case[] }

const quote = (a: string) => (/^[\w./:=,@-]+$/.test(a) ? a : a.includes("=") && /^[\w./:-]+=/.test(a) ? `${a.slice(0, a.indexOf("=") + 1)}"${a.slice(a.indexOf("=") + 1)}"` : `"${a}"`);

function run(c: Case): { block: string } {
  const dir = c.setup();
  try {
    const env: Record<string, string> = { PATH: process.env.PATH!, HOME: process.env.HOME!, NO_COLOR: "1", ...c.env };
    if (c.live) for (const k of ["AI_GATEWAY_API_KEY", "TYPESAFE_API_KEY", "GH_TOKEN", "GITHUB_TOKEN", "VERCEL_OIDC_TOKEN"]) if (process.env[k]) env[k] = process.env[k]!;
    const r = spawnSync("bun", [BIN, ...c.args], { cwd: dir, encoding: "utf8", env, timeout: 600_000 });
    const clean = (s: string) => s.replaceAll(dir, ".").replace(/\r?[^\n]*\r/g, "").replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
    const stdout = clean(r.stdout ?? "");
    const stderr = clean(r.stderr ?? "");
    const parts = [
      `<!-- case: ${c.id} -->`,
      `### ${c.title}`,
      "",
      ...(c.note ? [c.note, ""] : []),
      "```sh",
      `npx @kelbie/hunch ${c.args.map(quote).join(" ")}`,
      "```",
      "",
      `Exit code **${r.status}**.${c.live ? ` Captured from a real run with hunch ${VERSION} on ${new Date().toISOString().slice(0, 10)}; model output varies between runs.` : ""}`,
      "",
    ];
    if (stderr) parts.push("stderr:", "", "```text", stderr, "```", "");
    if (stdout) parts.push("stdout:", "", "```" + (stdout.startsWith("{") ? "json" : "text"), stdout, "```", "");
    for (const f of c.show ?? []) {
      const path = join(dir, f);
      if (existsSync(path)) parts.push(`\`${f}\` afterwards:`, "", "```" + (f.endsWith(".ts") ? "ts" : f.endsWith(".yml") ? "yaml" : f.endsWith(".toml") ? "toml" : "text"), readFileSync(path, "utf8").trimEnd(), "```", "");
    }
    parts.push("<!-- /case -->");
    return { block: parts.join("\n") };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const pages: Page[] = [
  {
    file: "init.md",
    title: "hunch init: examples",
    intro: "`init` writes the config, and the Actions workflow when asked. At a terminal it asks with arrow keys; any flag skips the questions, which is how an agent runs it.",
    cases: [
      { id: "init-yes", title: "Take the detected defaults", note: "A `package.json` means TypeScript: `hunch.config.ts` with the recommended and TypeScript presets.", args: ["init", "--yes"], setup: () => repo({ "package.json": "{}\n" }), show: ["hunch.config.ts"] },
      { id: "init-rust", title: "A Rust crate gets TOML", args: ["init", "--yes"], setup: () => repo({ "Cargo.toml": "[package]\nname = \"crate\"\nversion = \"0.1.0\"\n" }), show: ["hunch.toml"] },
      { id: "init-everything", title: "Every answer as a flag", note: "A mixed repository, reviewed by the GitHub App, on Vercel Hobby, with one rule of its own.", args: ["init", "--preset", "ts,rust", "--target", "app", "--include", "src/**", "--no-zero-data-retention", "--fail-on-error", "--rule", "api/stable-errors=Error responses keep their code field, because clients branch on it."], setup: () => repo({ "package.json": "{}\n" }), show: ["hunch.config.ts"] },
      { id: "init-actions", title: "Review PRs with GitHub Actions", note: "Writes the workflow as well. It pins the Action to the version that wrote it.", args: ["init", "--preset", "general", "--target", "actions"], setup: () => repo({ "README.md": "# docs\n" }), show: ["hunch.toml", ".github/workflows/hunch.yml"] },
      { id: "init-exists", title: "A config already exists", note: "init never rewrites a config. Edit the file instead, then run `hunch config`.", args: ["init", "--yes"], setup: () => repo({ "package.json": "{}\n", "hunch.config.ts": "export default {};\n" }) },
    ],
  },
  {
    file: "config.md",
    title: "hunch config: examples",
    intro: "Every example runs in the same small shop repository, whose `hunch.config.ts` uses all four rule types, a `reference` and an override. It is printed at the end of this page.",
    cases: [
      { id: "config-list", title: "Is the config valid, and which rules are on?", args: ["config"], setup: shop },
      { id: "config-stale", title: "Guidance that has not been compiled", note: "The config selects a skill and AGENTS.md, but there is no `hunch.lock` yet, so a review would be incomplete. Only the first lines are the point here.", args: ["config"], setup: guidedShop },
      { id: "config-file", title: "Which rules are asked about one file?", note: "Overrides and each rule's `files` are applied; rules turned off are left out.", args: ["config", "--file", "src/api/errors.test.ts"], setup: shop },
      { id: "config-explain-plain", title: "What a plain-English rule actually asks", args: ["config", "--explain", "api/stable-errors"], setup: shop },
      { id: "config-explain-noul", title: "What a noul rule asks", args: ["config", "--explain", "tests/weakened"], setup: shop },
      { id: "config-explain-choice", title: "What a choice rule asks", args: ["config", "--explain", "payments/retry-safety"], setup: shop },
      { id: "config-explain-score", title: "What a score rule asks", args: ["config", "--explain", "tests/specific"], setup: shop },
      { id: "config-typo", title: "A typo, caught before anything is spent", note: "The rule id `docs/contradictory-coment` does not exist, and the `reference` file is missing.", args: ["config"], setup: () => repo({ ...SHOP_BASE, "docs/contracts.md": "", "hunch.config.ts": SHOP_CONFIG.replace('"docs/contradictory-comment"', '"docs/contradictory-coment"').replace("docs/contracts.md", "docs/contract.md") }) },
      { id: "config-json", title: "The same, as JSON", note: "For an agent: `valid`, `problems`, `settings`, `rules` and `overrides`.", args: ["config", "--reporter", "json", "--rule", "api/pagination=List endpoints keep returning a next cursor."], setup: () => repo({ "package.json": "{}\n" }) },
    ],
  },
  {
    file: "check.md",
    title: "hunch check: examples",
    intro: "The shop repository's `feature` branch changes a payment retry to mint a new idempotency key each attempt, and loosens a test. `--base main` compares against it.",
    cases: [
      { id: "check-dry", title: "What would this cost?", args: ["check", "--base", "main", "--dry-run"], setup: shop },
      { id: "check-only-dry", title: "Try one rule", args: ["check", "--base", "main", "--only", "payments/retry-safety", "--dry-run"], setup: shop },
      { id: "check-all-dry", title: "Whole files, not just the change", args: ["check", "--all", "src/payments", "--dry-run"], setup: shop },
      { id: "check-noconfig-dry", title: "No config: rules on the command line", args: ["check", "--base", "main", "--rule", "payments/idempotent=Every retry of one payment reuses its idempotency key.", "--dry-run"], setup: () => repo(SHOP_BASE, SHOP_CHANGE) },
      { id: "check-noconfig", title: "No config and no rules", args: ["check", "--base", "main"], setup: () => repo(SHOP_BASE, SHOP_CHANGE) },
      { id: "check-text", title: "A real review", live: true, args: ["check", "--base", "main"], setup: shop },
      { id: "check-json", title: "A real review, as JSON", live: true, args: ["check", "--base", "main", "--only", "payments/retry-safety,tests/weakened", "--reporter", "json", "--code"], setup: shop },
    ],
  },
  {
    file: "find.md",
    title: "hunch find: examples",
    intro: "`find` scores every chunk of the repository against a task. It needs no rules, and no config at all.",
    cases: [
      { id: "find-dry", title: "What would a search cost?", args: ["find", "make payment retries configurable", "--dry-run"], setup: shop },
      { id: "find-noconfig-dry", title: "No config", args: ["find", "make payment retries configurable", "--dry-run"], setup: () => repo(SHOP_BASE) },
      { id: "find-markdown", title: "A real search, as Markdown for an agent", live: true, args: ["find", "make payment retries configurable", "--reporter", "markdown"], setup: shop },
      { id: "find-json", title: "A real search, as JSON", live: true, args: ["find", "make payment retries configurable", "--facet", "edit,test", "--reporter", "json", "--top", "3"], setup: shop },
    ],
  },
  {
    file: "compile.md",
    title: "hunch compile: examples",
    intro: "`compile` turns Agent Skills and `AGENTS.md` into review questions in `hunch.lock`. Here the shop's config selects its one skill and its root `AGENTS.md` (`skills: [\"./.agents/skills/api-style\"]`, `agentsMd: true`).",
    cases: [
      { id: "compile-dry", title: "What would be compiled?", args: ["compile", "--dry-run"], setup: guidedShop },
      { id: "compile-noninteractive", title: "No terminal, no previous lock, no --with", note: "An agent must say which compiler to use.", args: ["compile"], setup: guidedShop },
      { id: "compile-nothing", title: "Nothing to compile", args: ["compile", "--dry-run"], setup: shop },
      { id: "compile-claude", title: "Compile with Claude Code", live: true, needs: "Claude Code installed and logged in", args: ["compile", "--with", "claude", "--effort", "low"], setup: guidedShop, show: ["hunch.lock"] },
    ],
  },
  {
    file: "doctor.md",
    title: "hunch doctor: examples",
    intro: "`doctor` answers \"why did my PR get no review?\" using your `gh` login. Captured against the Hunch repository itself.",
    cases: [
      { id: "doctor-local", title: "Not a GitHub repository", args: ["doctor"], setup: () => repo({ "package.json": "{}\n", "hunch.config.ts": "export default {};\n" }) },
      { id: "doctor-hunch", title: "The Hunch repository", live: true, needs: "a `gh` login (no model key)", args: ["doctor", "--reporter", "json"], setup: () => { const d = mkdtempSync(join(tmpdir(), "hunch-example-")); cpSync(join(root, "hunch.config.ts"), join(d, "hunch.config.ts")); mkdirSync(join(d, ".github/workflows"), { recursive: true }); cpSync(join(root, ".github/workflows/hunch.yml"), join(d, ".github/workflows/hunch.yml")); git(d, "init", "--quiet"); git(d, "remote", "add", "origin", "https://github.com/Kelbie/hunch.git"); return d; } },
    ],
  },
  {
    file: "eval.md",
    title: "hunch eval: examples",
    intro: "`eval` runs rules over labelled `.diff` fixtures and prints precision and recall per rule. Each fixture starts with `# expect: rule-a, rule-b`.",
    cases: [
      { id: "eval-missing", title: "No fixtures", args: ["eval", "fixtures"], setup: () => { const d = repo({ ...SHOP_BASE, "hunch.config.ts": SHOP_CONFIG, "fixtures/.keep": "" }); return d; } },
      { id: "eval-presets", title: "The presets on Hunch's own fixtures", live: true, args: ["eval", "examples/presets", "--config", '{"extends":["hunch:recommended","hunch:typescript","hunch:rust"],"zeroDataRetention":false}'], setup: () => { const d = mkdtempSync(join(tmpdir(), "hunch-example-")); cpSync(join(root, "examples/presets"), join(d, "examples/presets"), { recursive: true }); git(d, "init", "--quiet"); return d; } },
    ],
  },
];

/** Blocks already in a page, by case id, so live captures survive an offline regeneration. */
function existingBlocks(path: string): Map<string, string> {
  const blocks = new Map<string, string>();
  if (!existsSync(path)) return blocks;
  for (const m of readFileSync(path, "utf8").matchAll(/<!-- case: ([\w-]+) -->[\s\S]*?<!-- \/case -->/g)) blocks.set(m[1]!, m[0]);
  return blocks;
}

function render(page: Page): string {
  const path = join(OUT, page.file);
  const previous = existingBlocks(path);
  const blocks = page.cases.map((c) => {
    if (c.live && !live) {
      return previous.get(c.id) ?? [
        `<!-- case: ${c.id} -->`, `### ${c.title}`, "", "```sh", `npx @kelbie/hunch ${c.args.map(quote).join(" ")}`, "```", "",
        `Not captured yet: this needs ${c.needs ?? "a model key, because it calls Jev"}. Run \`bun scripts/skill-examples.ts --live\` where that is available.`, "<!-- /case -->",
      ].join("\n");
    }
    return run(c).block;
  });
  const shopConfig = page.file === "config.md" ? ["", "## The shop's config", "", "```ts", SHOP_CONFIG.trimEnd(), "```", ""] : [];
  return [
    `<!-- Generated by scripts/skill-examples.ts from real runs. Do not edit by hand. -->`,
    "",
    `# ${page.title}`,
    "",
    page.intro,
    "",
    blocks.join("\n\n"),
    ...shopConfig,
  ].join("\n").trimEnd() + "\n";
}

/** Offline blocks only: live ones legitimately differ between runs. */
const offline = (text: string) => text.replace(/<!-- case: [\w-]+ -->[\s\S]*?<!-- \/case -->/g, (b) => (/Captured from a real run|Not captured yet/.test(b) ? "<live>" : b));

mkdirSync(OUT, { recursive: true });
let stale: string[] = [];
for (const page of pages) {
  const text = render(page);
  const path = join(OUT, page.file);
  if (checking) {
    if (!existsSync(path) || offline(readFileSync(path, "utf8")) !== offline(text)) stale.push(page.file);
  } else writeFileSync(path, text);
}
if (checking && stale.length) {
  console.error(`skills/hunch/examples is out of date: ${stale.join(", ")}. Run \`bun scripts/skill-examples.ts\`.`);
  process.exit(1);
}
if (!checking) console.log(`wrote ${pages.length} example pages to ${OUT}${live ? " (live cases included)" : ""}`);
