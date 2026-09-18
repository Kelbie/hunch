import { describe, expect, test } from "bun:test";
import { applyPresets, tomlToConfig } from "../src/load/index.js";
import { evaluateConfigSource } from "../src/load/static-ts.js";
import { ConfigError, parseConfig } from "../src/schema.js";

const TS = `
import { defineConfig, noul, choice, score } from "@hunch/cli";

const common = ["dist"];

export default defineConfig({
  model: "jev-1.13.0",
  extends: ["hunch:recommended"],
  include: ["src/**/*.{ts,tsx}"],
  ignore: [...common, "**/*.generated.ts"],
  rules: {
    "docs/contradictory-comment": "off",
    "style/error-handling": ["error", choice({
      instructions: "How does new code in \`hunk\` handle failures?",
      criteria: { result: "Returns a Result.", throws: "Throws.", none: "No failure handling." },
      report: ["throws"],
    })],
    "style/button-variant": ["error", noul({
      instructions: "Does \`hunk\` use the " + "destructive variant wrongly?",
      when: /variant=["']destructive/,
      threshold: 0.7,
    })],
    "team/no-client-secrets": ["error", "API keys are never read in client code."],
  },
  overrides: [{ files: ["**/*.test.ts"], rules: { "style/error-handling": "off" } }],
}) satisfies unknown;
`;

describe("static TS config", () => {
  test("evaluates helpers, spreads, concatenation and regex without executing code", () => {
    const cfg = applyPresets(parseConfig(evaluateConfigSource(TS), "hunch.config.ts"));
    expect(cfg.ignore).toEqual(["dist", "**/*.generated.ts"]);
    expect(cfg.rules["docs/contradictory-comment"]!.level).toBe("off");
    expect(cfg.rules["docs/contradictory-comment"]!.question?.kind).toBe("noul"); // inherited from preset
    const btn = cfg.rules["style/button-variant"]!.question!;
    expect(btn.kind).toBe("noul");
    expect(btn.instructions).toContain("destructive variant");
    expect(btn.when).toEqual({ source: "variant=[\"']destructive", flags: "" });
    expect(cfg.rules["team/no-client-secrets"]!.question!.instructions).toContain("API keys");
  });

  test.each([
    ["function call", `import fs from "node:fs"; export default fs.readFileSync("x")`],
    ["unknown call", `export default fetch("https://evil")`],
    ["template expression", "const x = 1; export default { model: `${x}` }"],
    ["getter", `export default { get model() { return "x" } }`],
    ["side-effect statement", `console.log(1); export default {}`],
    ["let binding", `let a = 1; export default {}`],
  ])("rejects %s", (_, src) => {
    expect(() => evaluateConfigSource(src)).toThrow(ConfigError);
  });

  test("requires a default export", () => {
    expect(() => evaluateConfigSource(`const a = {}`)).toThrow(/export default/);
  });
});

describe("TOML config", () => {
  const TOML = `
model = "jev-1.13.0"
extends = ["hunch:recommended"]
include = ["src/**/*.rs"]
agents-md = true
fail-on-error = true
skills = ["./skills/*", { repo = "vercel-labs/agent-skills", skill = "web-design-guidelines" }]

[rules]
"docs/contradictory-comment" = "off"
"team/no-unwrap-in-lib" = ["warn", "Library code under src/ never calls .unwrap() on a Result."]

[rules."team/unsafe-justified"]
level = "error"
noul = "Does \`hunk\` add an unsafe block without a SAFETY comment?"
when = "unsafe"
threshold = 0.8

[rules."team/focus"]
score = "How focused is \`hunk\`?"
criteria = ["Sprawling", "Mixed", "Focused"]
report-below = 0.3

[rules."style/errors"]
choice = "How are errors handled?"
criteria = { question-mark = "Propagates with ?", panics = "Panics", other = "Other" }
report = ["panics"]

[[overrides]]
files = ["tests/**"]
[overrides.rules]
"team/no-unwrap-in-lib" = "off"
`;

  test("kebab-case keys, table rules and overrides parse to the same schema", () => {
    const cfg = applyPresets(parseConfig(tomlToConfig(TOML), "hunch.toml"));
    expect(cfg.agentsMd).toBe(true);
    expect(cfg.failOnError).toBe(true);
    expect(cfg.skills[1]).toEqual({ repo: "vercel-labs/agent-skills", skill: "web-design-guidelines" });
    const unsafe = cfg.rules["team/unsafe-justified"]!;
    expect(unsafe.level).toBe("error");
    expect(unsafe.question).toMatchObject({ kind: "noul", threshold: 0.8, when: { source: "unsafe" } });
    expect(cfg.rules["team/focus"]!.question).toMatchObject({ kind: "score", reportBelow: 0.3 });
    // user-chosen option names are not camelized
    expect(Object.keys((cfg.rules["style/errors"]!.question as { criteria: object }).criteria)).toContain("question-mark");
    expect(cfg.overrides[0]!.rules["team/no-unwrap-in-lib"]!.level).toBe("off");
  });

  test("reports readable errors", () => {
    expect(() => parseConfig(tomlToConfig(`[rules]\n"x" = ["loud", "y"]`), "hunch.toml")).toThrow(/hunch.toml is invalid/);
  });
});
