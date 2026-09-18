import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { z } from "zod";
import { EXTRACTION_SYSTEM, extractedSchema, extractionPrompt, gatewayExtractor, type RuleExtractor } from "../../core/src/index.js";

/**
 * Who turns guidance into hunch.lock rules. Local coding agents use the
 * subscription the developer already has; the gateway stays available for
 * people without one. PR reviews never use any of these, only Jev.
 */
export type CompilerAgent = "claude" | "codex" | "gateway";
export interface CompilerChoice {
  agent: CompilerAgent;
  /** Agent model override; the agent's own default when omitted. The gateway model comes from `compileModel`. */
  model?: string;
  effort?: string;
}

export const AGENTS: Record<CompilerAgent, { label: string; bin?: string; efforts: string[]; defaultEffort?: string }> = {
  claude: { label: "Claude Code", bin: "claude", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
  codex: { label: "Codex", bin: "codex", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" },
  gateway: { label: "Vercel AI Gateway", efforts: [] },
};

/** Coding-agent CLIs on PATH, in menu order. */
export function installedAgents(env: Record<string, string | undefined> = process.env): CompilerAgent[] {
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? ["", ".cmd", ".exe"] : [""];
  return (["claude", "codex"] as const).filter((a) => dirs.some((d) => exts.some((x) => existsSync(join(d, AGENTS[a].bin! + x)))));
}

/**
 * The compiler identity recorded in hunch.lock. Unchanged sources are only reused
 * under the same identity. A gateway id is the bare model, as in older locks.
 */
export function compilerId(choice: CompilerChoice, compileModel: string): string {
  if (choice.agent === "gateway") return compileModel;
  return `${choice.agent}${choice.model ? `:${choice.model}` : ""}${choice.effort ? `@${choice.effort}` : ""}`;
}

/** Reads a previous choice back from hunch.lock, e.g. to preselect it. */
export function parseCompilerId(id: string): CompilerChoice {
  const m = /^(claude|codex)(?::([^@]+))?(?:@(\w+))?$/.exec(id);
  if (!m) return { agent: "gateway" };
  return { agent: m[1] as CompilerAgent, ...(m[2] ? { model: m[2] } : {}), ...(m[3] ? { effort: m[3] } : {}) };
}

export function validateChoice(choice: CompilerChoice): CompilerChoice {
  const spec = AGENTS[choice.agent];
  if (!spec) throw new Error(`Unknown compiler "${choice.agent}". Use claude, codex or gateway.`);
  if (choice.agent === "gateway") {
    if (choice.effort || choice.model) throw new Error("--effort and --model apply to claude and codex; set compileModel for the gateway.");
    return choice;
  }
  const effort = choice.effort ?? spec.defaultEffort;
  if (effort && !spec.efforts.includes(effort)) throw new Error(`${spec.label} effort must be one of: ${spec.efforts.join(", ")}.`);
  if (choice.model && !/^[\w.\-/[\]]+$/.test(choice.model)) throw new Error("Invalid --model.");
  return { ...choice, effort };
}

/** Runs a command with `input` on stdin; resolves stdout, rejects on exit code or timeout. */
export type Runner = (cmd: string, args: string[], opts: { input: string; cwd: string; timeoutMs: number }) => Promise<string>;

export const spawnRunner: Runner = (cmd, args, { input, cwd, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) return resolve(out);
      const why = signal ? `stopped after ${Math.round(timeoutMs / 1000)}s` : `exited with ${code}`;
      const tail = err.trim().split("\n").slice(-3).join("\n");
      reject(new Error(`${cmd} ${why}${tail ? `: ${tail}` : ""}`));
    });
    child.stdin.on("error", () => {}); // reported through close
    child.stdin.end(input);
  });

const TIMEOUT_MS = 10 * 60_000;

function jsonSchema(): Record<string, unknown> {
  const { $schema: _, ...schema } = z.toJSONSchema(extractedSchema) as Record<string, unknown>;
  return schema;
}

/**
 * A rule extractor backed by a local coding agent. Each call runs in an empty
 * temporary directory so the agent sees no repository files or project
 * instructions; Claude runs without tools and Codex in its read-only sandbox.
 * The document stays data inside the prompt, and the answer is schema-checked.
 */
export function agentExtractor(choice: CompilerChoice, run: Runner = spawnRunner): RuleExtractor {
  const schema = jsonSchema();
  return {
    async extract(input) {
      const dir = mkdtempSync(join(tmpdir(), "hunch-compile-"));
      try {
        const raw = choice.agent === "claude" ? await runClaude(choice, input, schema, dir, run) : await runCodex(choice, input, schema, dir, run);
        const parsed = extractedSchema.safeParse(raw);
        if (!parsed.success) throw new Error(`${AGENTS[choice.agent].label} returned rules in an unexpected shape`);
        return parsed.data;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

async function runClaude(choice: CompilerChoice, input: Parameters<RuleExtractor["extract"]>[0], schema: object, cwd: string, run: Runner) {
  const args = [
    "-p", "--output-format", "json", "--json-schema", JSON.stringify(schema),
    "--tools", "", "--setting-sources", "", "--no-session-persistence",
    "--system-prompt", EXTRACTION_SYSTEM,
    ...(choice.effort ? ["--effort", choice.effort] : []),
    ...(choice.model ? ["--model", choice.model] : []),
  ];
  const out = await run("claude", args, { input: extractionPrompt(input), cwd, timeoutMs: TIMEOUT_MS });
  let result: { is_error?: boolean; subtype?: string; structured_output?: unknown };
  try { result = JSON.parse(out); } catch { throw new Error("Claude Code did not return JSON"); }
  if (result.is_error || result.structured_output === undefined) throw new Error(`Claude Code could not compile ${input.sourceId} (${result.subtype ?? "no structured output"})`);
  return result.structured_output;
}

async function runCodex(choice: CompilerChoice, input: Parameters<RuleExtractor["extract"]>[0], schema: object, cwd: string, run: Runner) {
  const schemaFile = join(cwd, ".schema.json");
  const outFile = join(cwd, ".answer.json");
  writeFileSync(schemaFile, JSON.stringify(schema));
  const args = [
    "exec", "--output-schema", schemaFile, "-o", outFile,
    "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "--color", "never", "-C", cwd,
    ...(choice.effort ? ["-c", `model_reasoning_effort="${choice.effort}"`] : []),
    ...(choice.model ? ["-m", choice.model] : []),
    "-",
  ];
  const prompt = `${EXTRACTION_SYSTEM}\n\nDo not run commands or read files. Answer only with the JSON object.\n\n${extractionPrompt(input)}`;
  await run("codex", args, { input: prompt, cwd, timeoutMs: TIMEOUT_MS });
  try { return JSON.parse(readFileSync(outFile, "utf8")); } catch { throw new Error(`Codex did not return JSON for ${input.sourceId}`); }
}

export function extractorFor(choice: CompilerChoice, config: { compileModel: string; zeroDataRetention: boolean }): RuleExtractor {
  return choice.agent === "gateway" ? gatewayExtractor(config.compileModel, config.zeroDataRetention) : agentExtractor(choice);
}

export function describeChoice(choice: CompilerChoice, compileModel: string): string {
  if (choice.agent === "gateway") return `${compileModel} via Vercel AI Gateway`;
  return `${AGENTS[choice.agent].label}${choice.model ? ` (${choice.model})` : ""}, ${choice.effort} effort`;
}
