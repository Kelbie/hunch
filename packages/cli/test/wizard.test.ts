import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askWizard, detectPreset, existingKey, hasGuidance, interactive, nextSteps, setRepoSecret, writeKey, type WizardIo } from "../src/setup/wizard.js";

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

test("the App path never asks for a model key, because the hosted App holds its own", async () => {
  const { io, asked } = scripted(["ts", "app"]);
  expect(await askWizard(io, context())).toMatchObject({ preset: "ts", target: "app", key: { kind: "later" } });
  expect(asked.some((q) => /key|provider/i.test(q))).toBe(false);
});

test("local setup asks for a key, and a blank answer defers instead of storing nothing", async () => {
  const withKey = scripted(["general", "local", "gateway", "sk-live-value"]);
  expect(await askWizard(withKey.io, context())).toMatchObject({ target: "local", key: { kind: "gateway", value: "sk-live-value" } });
  const blank = scripted(["general", "local", "gateway", "   "]);
  expect(await askWizard(blank.io, context())).toMatchObject({ key: { kind: "later" } });
});

test("a key already reachable by check is not asked for again", async () => {
  const { io, asked } = scripted(["ts", "local"]);
  expect(await askWizard(io, context({ keyPresent: true }))).toMatchObject({ key: { kind: "later" } });
  expect(asked).toHaveLength(2);
  expect(existingKey(project({ ".env.local": "AI_GATEWAY_API_KEY=x\n" }), {})).toBe("AI_GATEWAY_API_KEY");
  expect(existingKey(project({ ".env": "export TYPESAFE_API_KEY=y\n" }), {})).toBe("TYPESAFE_API_KEY");
  expect(existingKey(project({ ".env.local": "AI_GATEWAY_API_KEY=\n" }), {})).toBeNull();
  expect(existingKey(project(), { AI_GATEWAY_API_KEY: "from-env" })).toBe("AI_GATEWAY_API_KEY");
});

test("cancelling any question abandons the whole setup, so nothing half-configured is written", async () => {
  for (const answers of [[null], ["ts", null], ["ts", "local", null], ["ts", "local", "gateway", null], ["ts", "app", null]]) {
    expect(await askWizard(scripted(answers).io, context({ guidance: true }))).toBeNull();
  }
});

test("an existing config keeps its preset instead of offering to change it", async () => {
  const { io, asked } = scripted(["actions", "later"]);
  expect(await askWizard(io, context({ configExists: true, detected: "rust" }))).toMatchObject({ preset: "rust", target: "actions" });
  expect(asked[0]).toContain("Where should Hunch review");
  expect(asked.some((q) => /starter rules/i.test(q))).toBe(false);
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
  expect(nextSteps("local", { configFile: "hunch.toml", compiled: false, secretSet: false, keyDeferred: true })).toContain("export AI_GATEWAY_API_KEY");
});

test("piped or CI runs are never interactive, so scripted installs keep the flag behaviour", () => {
  const tty = { isTTY: true };
  const pipe = { isTTY: false };
  expect(interactive({}, tty, tty)).toBe(true);
  expect(interactive({ CI: "1" }, tty, tty)).toBe(false);
  expect(interactive({}, pipe, tty)).toBe(false);
  expect(interactive({}, tty, pipe)).toBe(false);
});
