import { isCancel, select } from "@clack/prompts";
import { AGENTS, installedAgents, parseCompilerId, validateChoice, type CompilerAgent, type CompilerChoice } from "./compilers.js";

export interface PickOptions {
  /** `--with`; skips the menu. */
  with?: string;
  effort?: string;
  model?: string;
  /** Compiler id from the current hunch.lock, preselected and reused without a terminal. */
  previous?: string;
}

interface Io {
  installed: CompilerAgent[];
  interactive: boolean;
  select: (opts: { message: string; options: { value: string; label: string; hint?: string }[]; initialValue?: string }) => Promise<string | null>;
}

const defaultIo = (): Io => ({
  installed: installedAgents(),
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI,
  select: async (opts) => { const v = await select(opts); return isCancel(v) ? null : v; },
});

/**
 * Decides which compiler writes hunch.lock. Flags win; a terminal gets arrow-key
 * menus; otherwise the compiler recorded in hunch.lock is reused. Returns null on cancel.
 */
export async function chooseCompiler(opts: PickOptions, io: Io = defaultIo()): Promise<CompilerChoice | null> {
  const previous = opts.previous ? parseCompilerId(opts.previous) : undefined;
  const ensureInstalled = (c: CompilerChoice) => {
    if (c.agent !== "gateway" && !io.installed.includes(c.agent)) throw new Error(`${AGENTS[c.agent].bin} is not on PATH. Install ${AGENTS[c.agent].label} or choose another compiler.`);
    return c;
  };

  if (opts.with) return ensureInstalled(validateChoice({ agent: opts.with as CompilerAgent, effort: opts.effort, model: opts.model }));

  if (!io.interactive) {
    if (!previous) throw new Error("choose a compiler with --with claude, --with codex or --with gateway.");
    return ensureInstalled(validateChoice({ ...previous, ...(opts.effort ? { effort: opts.effort } : {}), ...(opts.model ? { model: opts.model } : {}) }));
  }

  const agents: CompilerAgent[] = [...io.installed, "gateway"];
  const agent = await io.select({
    message: "Which model should turn your guidance into review questions?",
    options: agents.map((a) => ({
      value: a,
      label: AGENTS[a].label,
      hint: a === "gateway" ? "uses compileModel and AI_GATEWAY_API_KEY" : `local ${AGENTS[a].bin} CLI and its login`,
    })),
    initialValue: previous && agents.includes(previous.agent) ? previous.agent : agents[0],
  });
  if (agent === null) return null;
  const spec = AGENTS[agent as CompilerAgent];
  if (agent === "gateway" || opts.effort) return validateChoice({ agent: agent as CompilerAgent, effort: opts.effort, model: opts.model });

  const effort = await io.select({
    message: `${spec.label} effort`,
    options: spec.efforts.map((e) => ({ value: e, label: e, ...(e === spec.defaultEffort ? { hint: "recommended" } : {}) })),
    initialValue: previous?.agent === agent && previous.effort && spec.efforts.includes(previous.effort) ? previous.effort : spec.defaultEffort,
  });
  if (effort === null) return null;
  return validateChoice({ agent: agent as CompilerAgent, effort, model: opts.model ?? (previous?.agent === agent ? previous.model : undefined) });
}
