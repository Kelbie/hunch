import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { confidenceOf, validateAnswers, type Answer, type EvaluateRequest, type EvaluateResult, type JevClient, type WireQuestion } from "./jev.js";

/**
 * SemIf (https://github.com/TheoLeeCJ/SemIf) answers the same three question shapes as Jev, from an
 * open model the person runs themselves. It is a local program, not a hosted service: there is no
 * endpoint and no API key, so "signing in" is telling Hunch where the install and its model are.
 *
 * Every decision is one SemIf row — a state, a criterion and 2 to 16 described options — and comes
 * back as a probability over exactly those options. That is the whole of what SemIf reports, so the
 * three answer shapes are read from it here and nothing else is inferred.
 */
export interface SemifSettings {
  /** Python that can `import semif_phase1`. A virtualenv's own interpreter needs no activation. */
  python: string;
  /** The bridge script. Resolved from the installation when a run actually needs to start SemIf. */
  bridge?: string;
  /** Hugging Face id or local path, and the pinned revision SemIf requires for a remote model. */
  model: string;
  revision: string;
  /**
   * SemIf's scoring paths. `direct` scores each question on its own and always applies. `shared`
   * and `serial` reuse one prefilled state across a hunk's questions, which is far faster, but SemIf
   * refuses the request when the tokenizer does not split that state off the prompt exactly.
   */
  mode: "direct" | "serial" | "shared" | "reranker";
  backend: SemifBackend;
  device?: "auto" | "cuda" | "mps";
  dtype?: "bfloat16" | "float16" | "float32";
  /** Checkpoint for `backend: "llamacpp"`. */
  gguf?: string;
  threads?: number;
  mlxBits?: 4 | 8;
  /** SemIf never truncates: a prompt over this many tokens fails the request instead of being cut. */
  maxTokens: number;
  /** How long a model may take to load before Hunch stops waiting for it. */
  startupTimeoutMs: number;
}

/**
 * What each SemIf backend needs installed, and the extra that installs it. Recording a backend
 * whose runtime is absent is the failure this exists to prevent: SemIf only says so when it loads
 * the model, which is minutes into a run.
 */
export const SEMIF_BACKENDS = {
  torch: { module: "torch", extra: undefined, label: "PyTorch" },
  mlx: { module: "mlx.core", extra: "mlx", label: "MLX" },
  llamacpp: { module: "llama_cpp", extra: "llamacpp", label: "llama.cpp" },
} as const satisfies Record<string, { module: string; extra?: string; label: string }>;

export type SemifBackend = keyof typeof SEMIF_BACKENDS;

/**
 * The backend to use when nothing says otherwise. Apple Silicon runs SemIf on the GPU through MLX;
 * PyTorch there takes minutes to load a 4B model before it answers anything, which reads as a hang.
 */
export function defaultBackend(platform: string = process.platform, arch: string = process.arch): SemifBackend {
  return platform === "darwin" && arch === "arm64" ? "mlx" : "torch";
}

/** SemIf's published baseline for direct option logits, pinned as its own manifest pins it. */
export const SEMIF_DEFAULT_MODEL = "Qwen/Qwen3.5-4B";
export const SEMIF_DEFAULT_REVISION = "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a";

/** A SemIf decision row, exactly as `semif_phase1.core.validate_row` accepts it. */
export interface SemifRow {
  id: string;
  state: unknown;
  question: string;
  options: { id: string; description: string }[];
}

/** What SemIf returns for one row. Only the option order and its distribution are read. */
export interface SemifResult {
  id: string;
  option_ids: string[];
  probabilities: number[];
  input_tokens?: number;
  shared_timing?: { prefix_tokens?: number; true_suffix_tokens?: number };
}

/** SemIf reads option descriptions, not ids, so a noul with no criteria still needs two sentences. */
const NOUL_DEFAULTS = { true: "Yes: the criterion holds for this evidence.", false: "No: the criterion does not hold for this evidence." };
/** `semif_phase1` scores a single letter per option, and publishes sixteen answer slots. */
const MAX_OPTIONS = 16;

/** One question as the row SemIf scores. The ids are what `answersFrom` reads the distribution back by. */
export function rowFor(id: string, state: unknown, question: WireQuestion): SemifRow {
  const options =
    question.type === "noul"
      ? [
          { id: "true", description: question.criteria?.true ?? NOUL_DEFAULTS.true },
          { id: "false", description: question.criteria?.false ?? NOUL_DEFAULTS.false },
        ]
      : question.type === "choice"
        ? Object.entries(question.criteria).map(([label, description]) => ({ id: label, description }))
        : question.criteria.map((description, level) => ({ id: String(level), description }));
  if (options.length > MAX_OPTIONS) {
    throw new SemifError(`Question "${id}" offers ${options.length} options; SemIf scores at most ${MAX_OPTIONS}. Use fewer criteria, or a provider without that limit.`);
  }
  return { id, state, question: question.instructions, options };
}

export const rowsFor = (req: Pick<EvaluateRequest, "state" | "questions">): SemifRow[] =>
  Object.entries(req.questions).map(([id, question]) => rowFor(id, req.state, question));

/**
 * SemIf's option probabilities as the three answers a rule is written against. A noul reads the
 * "true" option; a choice takes the likeliest label; a score is the expected level under the
 * distribution, which keeps a rule's `reportBelow` sensitive to a model that is split between two
 * neighbouring levels. Confidence is computed the same way for every provider, in `confidenceOf`.
 */
export function answersFrom(req: Pick<EvaluateRequest, "questions">, results: readonly SemifResult[]): Record<string, Answer> {
  const answers: Record<string, Answer> = {};
  for (const result of results) {
    const question = req.questions[result.id];
    if (!question) throw new SemifError("SemIf answered a question that was not asked");
    if (result.option_ids.length !== result.probabilities.length) throw new SemifError("SemIf returned a distribution that does not match its options");
    const probabilities: Record<string, number> = {};
    result.option_ids.forEach((option, index) => { probabilities[option] = result.probabilities[index]!; });
    if (question.type === "noul") answers[result.id] = { type: "noul", p: probabilities["true"] ?? Number.NaN };
    else if (question.type === "choice") {
      const choice = result.option_ids.reduce((best, option) => (probabilities[option]! > probabilities[best]! ? option : best));
      answers[result.id] = { type: "choice", choice, probabilities, confidence: confidenceOf(probabilities) };
    } else {
      const score = result.option_ids.reduce((sum, option, index) => sum + index * probabilities[option]!, 0);
      answers[result.id] = { type: "score", score, probabilities, confidence: confidenceOf(probabilities) };
    }
  }
  return answers;
}

/** What SemIf charged for the request, as SemIf itself counts it: shared scoring prefills one state once. */
function inputTokens(results: readonly SemifResult[]): number {
  const shared = results[0]?.shared_timing;
  if (shared) return (shared.prefix_tokens ?? 0) + (shared.true_suffix_tokens ?? 0);
  return results.reduce((sum, r) => sum + (r.input_tokens ?? 0), 0);
}

/** Where `bridge.py` sits, from source and from either published bundle. `SEMIF_BRIDGE` overrides it. */
export function bridgePath(env: Record<string, string | undefined> = process.env): string {
  if (env.SEMIF_BRIDGE) return env.SEMIF_BRIDGE;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "..", "semif", "bridge.py"), join(here, "semif", "bridge.py")]) {
    if (existsSync(candidate)) return candidate;
  }
  // Reported rather than guessed: a missing bridge is a broken install, not a model failure.
  throw new SemifError("SemIf is not set up: the bridge script that runs it was not found in this installation. Set SEMIF_BRIDGE to bridge.py.");
}

const MODES = ["direct", "serial", "shared", "reranker"] as const;
const BACKENDS = Object.keys(SEMIF_BACKENDS) as SemifBackend[];

function oneOf<T extends string>(allowed: readonly T[], value: string | undefined, name: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new SemifError(`${name}=${value} is not one of ${allowed.join(", ")}.`);
  return value as T;
}

function positive(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new SemifError(`${name}=${value} must be a positive whole number.`);
  return n;
}

/** Whatever a repository's config fixes about SemIf. Everything else is a property of the machine. */
export interface SemifConfig {
  model?: string;
  revision?: string;
  mode?: SemifSettings["mode"];
  backend?: SemifSettings["backend"];
  maxTokens?: number;
}

/**
 * The settings a run uses: the config a repository commits, with anything this machine sets in the
 * environment on top. A config cannot know which Python, which checkpoint or which GPU is here, and
 * a machine that cannot run what the repository assumed has to be able to say so.
 */
export function semifSettings(cfg: SemifConfig = {}, env: Record<string, string | undefined> = process.env): SemifSettings {
  return {
    python: env.SEMIF_PYTHON || "python3",
    bridge: env.SEMIF_BRIDGE,
    model: env.SEMIF_MODEL || cfg.model || SEMIF_DEFAULT_MODEL,
    revision: env.SEMIF_REVISION || cfg.revision || SEMIF_DEFAULT_REVISION,
    mode: oneOf(MODES, env.SEMIF_MODE, "SEMIF_MODE") ?? cfg.mode ?? "direct",
    backend: oneOf(BACKENDS, env.SEMIF_BACKEND, "SEMIF_BACKEND") ?? cfg.backend ?? defaultBackend(),
    device: oneOf(["auto", "cuda", "mps"] as const, env.SEMIF_DEVICE, "SEMIF_DEVICE"),
    dtype: oneOf(["bfloat16", "float16", "float32"] as const, env.SEMIF_DTYPE, "SEMIF_DTYPE"),
    gguf: env.SEMIF_GGUF,
    threads: positive(env.SEMIF_THREADS, "SEMIF_THREADS"),
    mlxBits: env.SEMIF_MLX_BITS ? (Number(oneOf(["4", "8"] as const, env.SEMIF_MLX_BITS, "SEMIF_MLX_BITS")) as 4 | 8) : undefined,
    maxTokens: positive(env.SEMIF_MAX_TOKENS, "SEMIF_MAX_TOKENS") ?? cfg.maxTokens ?? 32_768,
    // A first run downloads several gigabytes before it can answer anything.
    startupTimeoutMs: (positive(env.SEMIF_STARTUP_SECONDS, "SEMIF_STARTUP_SECONDS") ?? 600) * 1000,
  };
}

export function bridgeArgs(s: SemifSettings): string[] {
  return [
    s.bridge ?? bridgePath(), "--model", s.model, "--revision", s.revision, "--mode", s.mode, "--backend", s.backend,
    "--max-tokens", String(s.maxTokens),
    ...(s.device ? ["--device", s.device] : []),
    ...(s.dtype ? ["--dtype", s.dtype] : []),
    ...(s.gguf ? ["--gguf", s.gguf] : []),
    ...(s.threads ? ["--llama-threads", String(s.threads)] : []),
    ...(s.mlxBits ? ["--mlx-bits", String(s.mlxBits)] : []),
  ];
}

/** How a run names the model that answered it, for the report that lists them. */
export const semifModelId = (s: SemifSettings): string => `semif:${s.model}@${s.revision.slice(0, 8)} (${s.mode}, ${s.backend})`;

export class SemifError extends Error {
  override name = "SemifError";
}

type Spawn = (command: string, args: string[]) => ChildProcessWithoutNullStreams;

interface Pending { resolve(results: SemifResult[]): void; reject(error: Error): void }

/**
 * One loaded model for as long as the caller wants it. SemIf's own runner loads a model, reads a
 * file and exits, which would mean reloading several gigabytes for every hunk; the bridge keeps it
 * loaded and answers requests as they arrive. It starts on the first question, so a dry run, an
 * empty diff or a config check never waits for a model, and it runs until `close`, which the caller
 * owes it: a loaded model holds a process, and an unclosed one keeps the command from ending.
 */
export function semifClient(settings: SemifSettings, spawnProcess: Spawn = (c, a) => spawn(c, a, { stdio: ["pipe", "pipe", "pipe"] })): ClosableClient {
  let session: Promise<Session> | undefined;
  return {
    close() {
      // Never started: there is nothing to close, and starting one to close it would load a model.
      void session?.then((active) => active.close(), () => {});
    },
    async evaluate(req) {
      const active = await (session ??= start(settings, spawnProcess));
      const rows = rowsFor(req);
      const results = await active.send(rows, req.signal);
      if (results.length !== rows.length) throw new SemifError("SemIf returned an incomplete answer set");
      const answers = answersFrom(req, results);
      validateAnswers(req, answers);
      return { answers, usage: { inputTokens: inputTokens(results) }, modelId: semifModelId(settings) };
    },
  };
}

interface Session { send(rows: SemifRow[], signal?: AbortSignal): Promise<SemifResult[]>; close(): void }

/**
 * A provider that holds an operating system resource. The model is worth keeping loaded for a whole
 * review, so nothing closes it between hunks; whoever opened it says when the work is over.
 */
export interface ClosableClient extends JevClient { close(): void }

/** Ends a provider that holds one, so a finished run exits. Any other client is left alone. */
export function closeClient(client: JevClient): void {
  const closable = client as Partial<ClosableClient>;
  if (typeof closable.close === "function") closable.close();
}

/** The last of what the bridge said on stderr, so a failure to start can name its own cause. */
const STDERR_KEPT = 4000;

function start(settings: SemifSettings, spawnProcess: Spawn): Promise<Session> {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnProcess(settings.python, bridgeArgs(settings));
  } catch (error) {
    throw new SemifError(`SemIf could not start: ${settings.python} would not run (${(error as Error).message}).`);
  }
  const pending = new Map<string, Pending>();
  let ready: ((session: Session) => void) | undefined;
  let failed: ((error: Error) => void) | undefined;
  let stderr = "";
  let dead: Error | undefined;

  const die = (error: Error) => {
    dead ??= error;
    for (const [, p] of pending) p.reject(error);
    pending.clear();
    failed?.(error);
  };

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-STDERR_KEPT); });
  child.on("error", (error) => die(new SemifError(`SemIf could not start: ${settings.python} would not run (${error.message}).`)));
  child.on("exit", (code) => die(new SemifError(`SemIf stopped (exit ${code ?? "signal"}).${tail(stderr)}`)));

  child.stdout.setEncoding("utf8");
  let buffer = "";
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) receive(line);
    }
  });

  /** Closing stdin is how the bridge is asked to stop: it ends its read loop and exits by itself. */
  function close() {
    child.stdin.end();
    // A model that will not let go within a moment must not keep the command running.
    const force = setTimeout(() => child.kill(), 2_000);
    force.unref?.();
    child.once("exit", () => clearTimeout(force));
  }

  function receive(line: string) {
    let message: { ready?: boolean; id?: string | null; results?: SemifResult[]; error?: string };
    try { message = JSON.parse(line) as typeof message; }
    catch { return die(new SemifError("SemIf sent something that is not a response. Check that SEMIF_BRIDGE points at the bridge Hunch ships.")); }
    if (message.ready) return ready?.({ send, close });
    if (message.id === undefined || message.id === null) {
      return die(new SemifError(`SemIf could not start: it did not load the model.${message.error ? ` ${message.error}` : ""}${tail(stderr)}`));
    }
    const asked = pending.get(message.id);
    if (!asked) return;
    pending.delete(message.id);
    // A failed request is one failed request: the model is loaded and the next one may well answer.
    // The reuse modes only apply when the tokenizer splits the state off exactly, and SemIf says so
    // rather than scoring something else. The way out is the mode that never needs that.
    if (message.error) asked.reject(new SemifError(`SemIf could not answer: ${message.error}${/state prefix/i.test(message.error)
      ? " Set SEMIF_MODE=direct, or semif.mode in the config, to score each question on its own."
      : ""}`));
    else asked.resolve(message.results ?? []);
  }

  let next = 0;
  function send(rows: SemifRow[], signal?: AbortSignal): Promise<SemifResult[]> {
    if (dead) return Promise.reject(dead);
    const id = String(++next);
    const forget = () => pending.delete(id);
    return new Promise<SemifResult[]>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const abort = () => { forget(); reject(new Error("SemIf request cancelled")); };
      signal?.addEventListener("abort", abort, { once: true });
      child.stdin.write(`${JSON.stringify({ id, rows })}\n`, (error) => {
        if (!error) return;
        forget();
        reject(new SemifError(`SemIf could not be reached: ${error.message}`));
      });
    });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<Session>((resolve, reject) => {
    ready = resolve;
    failed = reject;
    if (dead) return reject(dead);
    timer = setTimeout(
      () => die(new SemifError(`SemIf did not load ${settings.model} within ${Math.round(settings.startupTimeoutMs / 1000)}s. A first run downloads the model; run it once by hand, or raise SEMIF_STARTUP_SECONDS.${tail(stderr)}`)),
      settings.startupTimeoutMs,
    );
    timer.unref?.();
  }).finally(() => { clearTimeout(timer); ready = undefined; failed = undefined; });
}

/** The end of the bridge's own output, which is where a missing dependency or a bad revision says so. */
function tail(stderr: string): string {
  const lines = stderr.trimEnd().split("\n").filter(Boolean).slice(-6);
  return lines.length ? `\n${lines.join("\n")}` : "";
}
