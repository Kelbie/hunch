import { VERSION } from "./version.js";

/** The presets a config can extend. Language presets are additive to `recommended`. */
export const PRESET_NAMES = ["recommended", "typescript", "rust"] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

/** Everything `init` decides about the config file, whether asked in the wizard or passed as flags. */
export interface ConfigAnswers {
  presets: PresetName[];
  /** Empty means every file. */
  include: string[];
  ignore: string[];
  failOnError: boolean;
  zeroDataRetention: boolean;
  task: "pr" | "none";
  /** Plain-English rules, id to sentence, written at `warn`. */
  rules: Record<string, string>;
}

const LANGUAGE_INCLUDE: Record<Exclude<PresetName, "recommended">, string> = {
  typescript: "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
  rust: "**/*.rs",
};
const LANGUAGE_IGNORE: Record<Exclude<PresetName, "recommended">, string[]> = {
  // The config itself matches a TypeScript include, and its rule text would trip its own rules.
  typescript: ["dist/**", "node_modules/**", "**/*.generated.ts", "hunch.config.ts"],
  rust: ["target/**"],
};
const GENERAL_IGNORE = ["node_modules/**", "dist/**", "target/**", ".git/**"];

/**
 * What a project gets when nobody chooses: a language's own files and build output, or, with no
 * language preset, every file except common build directories. Order is kept stable so the file
 * written for a flag is byte-for-byte the file written for the same wizard answers.
 */
export function defaultAnswers(presets: PresetName[]): ConfigAnswers {
  const languages = PRESET_NAMES.filter((p): p is Exclude<PresetName, "recommended"> => p !== "recommended" && presets.includes(p));
  return {
    presets: PRESET_NAMES.filter((p) => presets.includes(p)),
    include: languages.map((l) => LANGUAGE_INCLUDE[l]),
    ignore: languages.length ? [...new Set(languages.flatMap((l) => LANGUAGE_IGNORE[l]))] : GENERAL_IGNORE,
    failOnError: false,
    zeroDataRetention: true,
    task: "pr",
    rules: {},
  };
}

/** A TypeScript project gets `hunch.config.ts`; everything else gets `hunch.toml`, which needs no Node. */
export function configFileFor(answers: Pick<ConfigAnswers, "presets">): "hunch.config.ts" | "hunch.toml" {
  return answers.presets.includes("typescript") ? "hunch.config.ts" : "hunch.toml";
}

const list = (values: string[]) => `[${values.map((v) => JSON.stringify(v)).join(", ")}]`;

/** Writes only what differs from the schema's defaults, so the file shows the choices that were made. */
export function renderConfig(answers: ConfigAnswers): { file: "hunch.config.ts" | "hunch.toml"; text: string } {
  const file = configFileFor(answers);
  const extendsList = answers.presets.map((p) => `hunch:${p}`);
  const rules = Object.entries(answers.rules);
  if (file === "hunch.config.ts") {
    const lines = [`  extends: ${list(extendsList)},`];
    if (answers.include.length) lines.push(`  include: ${list(answers.include)},`);
    if (answers.ignore.length) lines.push(`  ignore: ${list(answers.ignore)},`);
    if (answers.failOnError) lines.push("  failOnError: true,");
    if (!answers.zeroDataRetention) lines.push("  // Vercel Hobby cannot enforce zero data retention; see the Hunch skill's config reference.", "  zeroDataRetention: false,");
    if (answers.task !== "pr") lines.push(`  task: ${JSON.stringify(answers.task)},`);
    if (rules.length) lines.push("  rules: {", ...rules.map(([id, text]) => `    ${JSON.stringify(id)}: ["warn", ${JSON.stringify(text)}],`), "  },");
    return { file, text: `import { defineConfig } from "@kelbie/hunch";\n\nexport default defineConfig({\n${lines.join("\n")}\n});\n` };
  }
  const lines = [`extends = ${list(extendsList)}`];
  if (answers.include.length) lines.push(`include = ${list(answers.include)}`);
  if (answers.ignore.length) lines.push(`ignore = ${list(answers.ignore)}`);
  if (answers.failOnError) lines.push("fail-on-error = true");
  if (!answers.zeroDataRetention) lines.push("# Vercel Hobby cannot enforce zero data retention; see the Hunch skill's config reference.", "zero-data-retention = false");
  if (answers.task !== "pr") lines.push(`task = ${JSON.stringify(answers.task)}`);
  if (rules.length) lines.push("", "[rules]", ...rules.map(([id, text]) => `${JSON.stringify(id)} = ["warn", ${JSON.stringify(text)}]`));
  return { file, text: `${lines.join("\n")}\n` };
}

export const TS_TEMPLATE = renderConfig(defaultAnswers(["recommended", "typescript"])).text;
export const TOML_TEMPLATE = renderConfig(defaultAnswers(["recommended", "rust"])).text;
export const GENERAL_TEMPLATE = renderConfig(defaultAnswers(["recommended"])).text;

export const GITHUB_WORKFLOW = `name: Hunch
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, edited]
permissions:
  contents: read
concurrency:
  group: hunch-\${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  review:
    if: >-
      !github.event.pull_request.draft &&
      github.event.pull_request.head.repo.full_name == github.repository &&
      github.actor != 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps:
      - name: Check API key setup
        env:
          AI_GATEWAY_API_KEY: \${{ secrets.AI_GATEWAY_API_KEY }}
        run: |
          if [ -z "$AI_GATEWAY_API_KEY" ]; then
            echo '::error::Add AI_GATEWAY_API_KEY in Settings > Secrets and variables > Actions.'
            exit 1
          fi
      - uses: actions/checkout@v7
        with:
          ref: \${{ github.event.pull_request.base.sha }}
          fetch-depth: 0
          persist-credentials: false
      - uses: Kelbie/hunch@v${VERSION}
        with:
          base: \${{ github.event.pull_request.base.sha }}
          head: \${{ github.event.pull_request.head.sha }}
        env:
          AI_GATEWAY_API_KEY: \${{ secrets.AI_GATEWAY_API_KEY }}
`;
