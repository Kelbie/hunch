import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askWizard, detectPreset, existingKey, hasGuidance, installSkill, interactive, nextSteps, presetsFor, ruleIdFor, setRepoSecret, splitGlobs, writeKey, type WizardIo } from "../src/setup/wizard.js";
import { applyPresets, evaluateConfigSource, parseConfig, tomlToConfig } from "../../core/src/index.js";
import { defaultAnswers, renderConfig } from "../src/templates.js";

function project(files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hunch-wizard-"));
  for (const [path, body] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

/** Answers the wizard's questions in order, recording what it was asked. */
function scripted(answers: unknown[]) {
  const asked: string[] = [];
  const notes: string[] = [];
  let i = 0;
  const next = () => answers[i++];
  const io: WizardIo = {
    async select(opts) { asked.push(opts.message); return next() as string | null; },
    async confirm(opts) { asked.push(opts.message); return next() as boolean | null; },
    async password(opts) { asked.push(opts.message); return next() as string | null; },
    async multiselect(opts) { asked.push(opts.message); return next() as string[] | null; },
    async text(opts) { asked.push(opts.message); const v = next(); return v === undefined ? opts.initialValue ?? "" : v as string | null; },
    note: (body) => { notes.push(body); },
    outro: () => {},
  };
  return { io, asked, notes };
}

const context = (over: Partial<Parameters<typeof askWizard>[1]> = {}) =>
  ({ root: "/tmp", detected: "ts" as const, configExists: false, guidance: false, keyPresent: false, ...over });

test("the project's own files choose the starter rules, and guidance is detected where agents keep it", () => {
  expect(detectPreset(project({ "Cargo.toml": "" }))).toBe("rust");
  expect(detectPreset(project({ "package.json": "{}" }))).toBe("ts");
  expect(detectPreset(project({ "Cargo.toml": "", "package.json": "{}" }))).toBe("rust");
  expect(detectPreset(project())).toBe("general");
  expect(hasGuidance(project({ "AGENTS.md": "# rules" }))).toBe(true);
  expect(hasGuidance(project({ ".agents/skills/x/SKILL.md": "s" }))).toBe(true);
  expect(hasGuidance(project({ "README.md": "" }))).toBe(false);
});

/** Answers for a new config, up to and including the target, in the order they are asked. */
const newConfig = (target: string) => [["recommended", "typescript"], undefined, undefined, target];
/** Retention, fail-on-error, PR context, no rule, then the skill question. */
const policyDefaults = ["enforce", false, true, "", false];

test("the App path never asks for a model key, because the hosted App holds its own", async () => {
  const { io, asked } = scripted([...newConfig("app"), ...policyDefaults]);
  expect(await askWizard(io, context())).toMatchObject({ config: { presets: ["recommended", "typescript"] }, target: "app", key: { kind: "later" } });
  expect(asked.some((q) => /key|provider/i.test(q))).toBe(false);
});

test("the wizard's defaults write exactly the file init writes with no questions", async () => {
  const { io } = scripted([...newConfig("app"), ...policyDefaults]);
  const answers = await askWizard(io, context());
  expect(renderConfig(answers!.config!)).toEqual(renderConfig(defaultAnswers(presetsFor("ts"))));
});

test("every wizard answer lands in a config the loader accepts", async () => {
  const { io } = scripted([["recommended", "rust", "typescript"], "src/**, **/*.{ts,rs}", "dist/**", "local", "later",
    "allow", true, false, "Error responses keep their \"code\" field.", "api/errors", true, true]);
  const answers = (await askWizard(io, context({ guidance: true })))!;
  expect(answers).toMatchObject({ compile: true, installSkill: true });
  const { file, text } = renderConfig(answers.config!);
  expect(file).toBe("hunch.config.ts");
  const config = applyPresets(parseConfig(evaluateConfigSource(text), file));
  expect(config).toMatchObject({ extends: ["hunch:recommended", "hunch:typescript", "hunch:rust"], include: ["src/**", "**/*.{ts,rs}"], ignore: ["dist/**"], zeroDataRetention: false, failOnError: true, task: "none" });
  expect(config.rules["api/errors"]!.question!.message).toBe('Error responses keep their "code" field.');
  const toml = renderConfig({ ...answers.config!, presets: ["recommended", "rust"] });
  expect(toml.file).toBe("hunch.toml");
  expect(applyPresets(parseConfig(tomlToConfig(toml.text), toml.file))).toMatchObject({ zeroDataRetention: false, failOnError: true, task: "none", rules: { "api/errors": { level: "warn" } } });
});

test("globs split on commas, but not the commas inside braces", () => {
  expect(splitGlobs("**/*.{ts,tsx}, src/**,,  ")).toEqual(["**/*.{ts,tsx}", "src/**"]);
  expect(splitGlobs("")).toEqual([]);
  expect(ruleIdFor("Error responses keep their code field!")).toBe("project/error-responses-keep-their");
});

test("presets name what a project is, and general means recommended alone", () => {
  expect(presetsFor("ts")).toEqual(["recommended", "typescript"]);
  expect(presetsFor("general")).toEqual(["recommended"]);
  expect(() => presetsFor("python")).toThrow("Unknown preset python");
});

test("local setup asks for a key, and a blank answer defers instead of storing nothing", async () => {
  const withKey = scripted([...newConfig("local"), "gateway", "sk-live-value", "user", ...policyDefaults]);
  expect(await askWizard(withKey.io, context())).toMatchObject({ target: "local", key: { kind: "gateway", value: "sk-live-value", scope: "user" } });
  const pinned = scripted([...newConfig("local"), "typesafe", "ts-key", "project", ...policyDefaults]);
  expect(await askWizard(pinned.io, context())).toMatchObject({ key: { kind: "typesafe", value: "ts-key", scope: "project" } });
  const blank = scripted([...newConfig("local"), "gateway", "   ", ...policyDefaults]);
  expect(await askWizard(blank.io, context())).toMatchObject({ key: { kind: "later" } });
});

test("a key already reachable by check is not asked for again", async () => {
  const { io, asked } = scripted([...newConfig("local"), ...policyDefaults]);
  expect(await askWizard(io, context({ keyPresent: true }))).toMatchObject({ key: { kind: "later" } });
  expect(asked.some((q) => /key|provider/i.test(q))).toBe(false);
  expect(existingKey(project({ ".env.local": "AI_GATEWAY_API_KEY=x\n" }), {})).toBe("AI_GATEWAY_API_KEY");
  expect(existingKey(project({ ".env": "export TYPESAFE_API_KEY=y\n" }), {})).toBe("TYPESAFE_API_KEY");
  expect(existingKey(project({ ".env.local": "AI_GATEWAY_API_KEY=\n" }), {})).toBeNull();
  expect(existingKey(project(), { AI_GATEWAY_API_KEY: "from-env" })).toBe("AI_GATEWAY_API_KEY");
});

test("cancelling any question abandons the whole setup, so nothing half-configured is written", async () => {
  const full = [["recommended"], "", "", "local", "gateway", "sk", "user", "enforce", false, true, "A rule.", "project/a", true, true];
  for (let i = 0; i < full.length; i++) {
    const answers = [...full.slice(0, i), null];
    expect(await askWizard(scripted(answers).io, context({ guidance: true }))).toBeNull();
  }
});

test("an existing config is never rewritten: the wizard only asks where reviews run", async () => {
  const { io, asked } = scripted(["actions", "later", false]);
  expect(await askWizard(io, context({ configExists: true, detected: "rust" }))).toMatchObject({ config: null, target: "actions" });
  expect(asked[0]).toContain("Where should Hunch review");
  expect(asked.some((q) => /starter rules|retention|rule of your own/i.test(q))).toBe(false);
});

test("the skill installer runs only through npx skills, with its output shown", () => {
  const calls: { cmd: string; args: string[]; stdio: unknown }[] = [];
  const run = ((cmd: string, args: string[], opts: { stdio: unknown }) => {
    calls.push({ cmd, args, stdio: opts.stdio });
    return { status: 0 };
  }) as unknown as typeof import("node:child_process").spawnSync;
  expect(installSkill("/tmp", run)).toBe(true);
  expect(calls[0]).toEqual({ cmd: "npx", args: ["skills", "add", "Kelbie/hunch", "--skill", "hunch", "-y"], stdio: "inherit" });
  expect(installSkill("/tmp", (() => ({ status: 1 })) as unknown as typeof run)).toBe(false);
});

test("the key is written owner-only to a git-ignored file, never to the committed config", () => {
  const root = project({ ".gitignore": "node_modules\n" });
  const path = writeKey(root, "AI_GATEWAY_API_KEY", "sk-secret");
  expect(readFileSync(path, "utf8")).toBe("AI_GATEWAY_API_KEY=sk-secret\n");
  expect(statSync(path).mode & 0o077).toBe(0);
  expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".env.local");
  // A second key appends; an existing name is never silently replaced.
  writeKey(root, "TYPESAFE_API_KEY", "ts-secret");
  expect(readFileSync(path, "utf8")).toBe("AI_GATEWAY_API_KEY=sk-secret\nTYPESAFE_API_KEY=ts-secret\n");
  expect(() => writeKey(root, "AI_GATEWAY_API_KEY", "other")).toThrow("already sets");
  expect(readFileSync(path, "utf8")).toContain("sk-secret");
  rmSync(root, { recursive: true, force: true });
});

test("an existing .gitignore that already covers env files is left alone", () => {
  const root = project({ ".gitignore": ".env*\n" });
  writeKey(root, "AI_GATEWAY_API_KEY", "sk");
  expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(".env*\n");
});

test("repository secrets go over stdin, never argv, so the key is not visible to other processes", () => {
  const calls: { args: string[]; input?: string }[] = [];
  const run = ((cmd: string, args: string[], opts: { input?: string }) => {
    calls.push({ args, input: opts.input });
    return { status: 0 } as ReturnType<typeof import("node:child_process").spawnSync>;
  }) as unknown as typeof import("node:child_process").spawnSync;
  setRepoSecret("AI_GATEWAY_API_KEY", "sk-secret", run);
  expect(calls[0]!.args).toEqual(["secret", "set", "AI_GATEWAY_API_KEY"]);
  expect(calls[0]!.args.join(" ")).not.toContain("sk-secret");
  expect(calls[0]!.input).toBe("sk-secret");
  const failing = (() => ({ status: 1 })) as unknown as typeof import("node:child_process").spawnSync;
  expect(() => setRepoSecret("AI_GATEWAY_API_KEY", "sk", failing)).toThrow("gh secret set");
});

test("next steps are ordered and name the base-branch requirement the README also states", () => {
  const app = nextSteps("app", { configFile: "hunch.config.ts", compiled: true, secretSet: false, keyDeferred: false });
  expect(app).toContain("1. Install the App");
  expect(app.indexOf("1. Install")).toBeLessThan(app.indexOf("2. Commit"));
  expect(app).toContain("hunch.lock");
  expect(app).toContain("base branch");
  expect(app).toContain("doctor");
  const actions = nextSteps("actions", { configFile: "hunch.toml", compiled: false, secretSet: true, keyDeferred: false });
  expect(actions).toContain("is set as a repository secret");
  expect(actions).toContain(".github/workflows/hunch.yml");
  expect(actions).not.toContain("hunch.lock");
  expect(nextSteps("local", { configFile: "hunch.toml", compiled: false, secretSet: false, keyDeferred: true })).toContain("hunch auth login");
  expect(nextSteps("local", { configFile: "hunch.toml", compiled: false, secretSet: false, keyDeferred: false, keyPath: "~/.config/hunch/credentials" })).toContain("~/.config/hunch/credentials");
});

test("piped or CI runs are never interactive, so scripted installs keep the flag behaviour", () => {
  const tty = { isTTY: true };
  const pipe = { isTTY: false };
  expect(interactive({}, tty, tty)).toBe(true);
  expect(interactive({ CI: "1" }, tty, tty)).toBe(false);
  expect(interactive({}, pipe, tty)).toBe(false);
  expect(interactive({}, tty, pipe)).toBe(false);
});
