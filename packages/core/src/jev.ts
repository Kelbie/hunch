import { z } from "zod";
import { experimental_evaluate as evaluate } from "ai";

/** Question as sent on the wire, in TypeSafe's vocabulary. */
export type WireQuestion =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

/** One normalised answer shape for both providers. */
export type Answer =
  | { type: "noul"; p: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number };

export interface EvaluateRequest {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, WireQuestion>;
  /** Caller deadline; adapters combine it with their own transport limit. */
  signal?: AbortSignal;
}

export interface EvaluateResult {
  answers: Record<string, Answer>;
  usage: { inputTokens: number };
  modelId: string;
}

export interface JevClient {
  evaluate(req: EvaluateRequest): Promise<EvaluateResult>;
}

/**
 * Confidence from a distribution: how far the top option sits above a uniform
 * guess, (p_max − 1/n) / (1 − 1/n). 1 = certain, 0 = no better than chance.
 * TypeSafe does not publish its formula and the gateway omits the field, so
 * hunch always computes this itself; `minConfidence` then means the same on
 * either provider.
 */
export function confidenceOf(probabilities: Record<string, number>): number {
  const ps = Object.values(probabilities);
  const n = ps.length;
  if (n < 2) return 0;
  const top = Math.max(...ps);
  return Math.max(0, Math.min(1, (top - 1 / n) / (1 - 1 / n)));
}

/**
 * Vercel AI Gateway via AI SDK `experimental_evaluate`. Auth comes from
 * AI_GATEWAY_API_KEY, or automatically from Vercel OIDC when deployed there.
 * The gateway serves `typesafe-ai/jev` (unpinned); the resolved model id is
 * returned so reports can show which build answered.
 */
export function gatewayClient(opts: { zeroDataRetention: boolean; gatewayModel?: string }): JevClient {
  return {
    async evaluate(req) {
      const questions = Object.fromEntries(
        Object.entries(req.questions).map(([id, q]) => [
          id,
          q.type === "noul"
            ? { type: "boolean" as const, instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) }
            : q,
        ]),
      );
      const res = await evaluate({
        model: opts.gatewayModel ?? "typesafe-ai/jev",
        state: req.state as never,
        questions: questions as never,
        // Free-tier 429 windows can outlast the SDK's default 2s + 4s backoff.
        // Five retries have 62s of default backoff; Retry-After may change it.
        // The shared signal bounds the whole call at 90s. The worker still
        // enforces 300s, including GitHub reads and publication overhead.
        maxRetries: 5,
        abortSignal: req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
        providerOptions: { gateway: { zeroDataRetention: opts.zeroDataRetention } },
      });
      const answers: Record<string, Answer> = {};
      for (const [id, a] of Object.entries(res.answers as Record<string, GatewayAnswer>)) {
        const q = req.questions[id]!;
        if (a.type === "boolean") answers[id] = { type: "noul", p: a.probability };
        else if (a.type === "choice") {
          const probabilities = a.probabilities ?? {};
          answers[id] = { type: "choice", choice: a.choice, probabilities, confidence: confidenceOf(probabilities) };
        } else {
          const probabilities = a.probabilities ?? {};
          answers[id] = { type: "score", score: a.score, probabilities, confidence: confidenceOf(probabilities) };
        }
      }
      validateAnswers(req, answers);
      return { answers, usage: { inputTokens: res.usage.inputTokens ?? 0 }, modelId: res.response.modelId };
    },
  };
}

type GatewayAnswer =
  | { type: "boolean"; probability: number }
  | { type: "choice"; choice: string; probabilities?: Record<string, number> }
  | { type: "score"; score: number; probabilities?: Record<string, number> };

/** TypeSafe's own REST API: POST https://api.typesafe.ai/v1/systemone. */
export function typesafeClient(opts: { apiKey: string; baseUrl?: string; fetch?: typeof fetch }): JevClient {
  const base = opts.baseUrl ?? "https://api.typesafe.ai/v1";
  const doFetch = opts.fetch ?? fetch;
  return {
    async evaluate(req) {
      const body = JSON.stringify({ model: req.model, state: req.state, questions: req.questions });
      let lastErr: unknown;
      const signal = req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000);
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await doFetch(`${base}/systemone`, {
          method: "POST",
          signal,
          headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
          body,
        });
        if (res.status === 429 || res.status === 529 || res.status >= 500) {
          lastErr = new JevError(res.status);
          await new Promise((r) => setTimeout(r, 2 ** attempt * 500 + Math.random() * 250));
          continue;
        }
        if (!res.ok) throw new JevError(res.status);
        const json = responseSchema.parse(await res.json());
        const answers: Record<string, Answer> = {};
        for (const [id, a] of Object.entries(json.answers)) {
          if (a.type === "noul") answers[id] = { type: "noul", p: a.noul };
          else if (a.type === "choice")
            answers[id] = { type: "choice", choice: a.choice, probabilities: a.probabilities, confidence: confidenceOf(a.probabilities) };
          else answers[id] = { type: "score", score: a.score, probabilities: a.probabilities, confidence: confidenceOf(a.probabilities) };
        }
        for (const answer of Object.values(answers)) {
          if (answer.type !== "noul" && Object.keys(answer.probabilities).length < 2) throw new Error("TypeSafe omitted its probability distribution");
        }
        validateAnswers(req, answers);
        return { answers, usage: { inputTokens: json.usage?.input_tokens ?? 0 }, modelId: json.model };
      }
      throw lastErr;
    },
  };
}

const probability = z.number().finite().min(0).max(1);
const distribution = z.record(z.string(), probability);
const responseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), z.discriminatedUnion("type", [
    z.object({ type: z.literal("noul"), noul: probability }),
    z.object({ type: z.literal("choice"), choice: z.string(), probabilities: distribution }),
    z.object({ type: z.literal("score"), score: z.number().finite(), probabilities: distribution }),
  ])),
  usage: z.object({ input_tokens: z.number().nonnegative() }).optional(),
});

/** Missing results are transport failures, never evidence that a rule passed. */
export function validateAnswers(req: EvaluateRequest, answers: Record<string, Answer>): void {
  if (Object.keys(answers).length !== Object.keys(req.questions).length) throw new Error("Jev returned an incomplete answer set");
  for (const [id, q] of Object.entries(req.questions)) {
    const a = answers[id];
    if (!a || a.type !== q.type) throw new Error("Jev returned an incompatible answer");
    if (a.type === "noul") probability.parse(a.p);
    if (a.type === "choice" && q.type === "choice" && !Object.hasOwn(q.criteria, a.choice)) throw new Error("Jev returned an unknown choice");
    if (a.type === "score" && q.type === "score" && (!Number.isFinite(a.score) || a.score < 0 || a.score > q.criteria.length - 1)) throw new Error("Jev returned an invalid score");
    if (a.type !== "noul" && q.type !== "noul" && Object.keys(a.probabilities).length) {
      const keys = q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
      const ps = distribution.parse(a.probabilities);
      if (Object.keys(ps).length !== keys.length || keys.some((k) => !Object.hasOwn(ps, k)) || Math.abs(Object.values(ps).reduce((n, p) => n + p, 0) - 1) > 0.02) throw new Error("Jev returned an invalid probability distribution");
    }
  }
}

export class JevError extends Error {
  override name = "JevError";
  constructor(
    readonly status: number,
  ) {
    super(`Jev request failed (HTTP ${status}). Check provider credentials, quota and availability.`);
  }
}

/** Picks a provider from config + environment. */
/** This many failures in a row, with no answer between them, is an outage rather than bad luck. */
export const OUTAGE_FAILURES = 8;

/**
 * Whether a provider failure means "nobody is signed in" rather than "try again". No amount of
 * further sending mends it, so a run stops on the first one and says how to sign in.
 */
export function isAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /No authentication provided|authentication failed|needs TYPESAFE_API_KEY|Invalid API key|HTTP 401|HTTP 403/i.test(message);
}

/**
 * A refusal that every request will meet alike: nobody is signed in, the account has no credit, or
 * it cannot honour the data-retention policy asked of it. A run ends on the first one instead of
 * repeating it.
 */
export function isSetupError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return isAuthError(error) || /Zero Data Retention|\bZDR\b|HTTP 402|insufficient (credit|funds|balance)/i.test(message);
}

type ProviderChoice = { provider?: "gateway" | "typesafe" };

/**
 * The provider a run uses. A config that names one is obeyed. One that does not leaves it to the
 * credentials at hand, so a person signed in with a TypeSafe key can review a repository that has
 * no Hunch config, while the hosted App and CI, which hold no such key, stay on the Gateway.
 */
export function providerFor(cfg: ProviderChoice, env: Record<string, string | undefined> = process.env): "gateway" | "typesafe" {
  return cfg.provider ?? (env.TYPESAFE_API_KEY && !env.AI_GATEWAY_API_KEY ? "typesafe" : "gateway");
}

export function clientFromEnv(
  cfg: ProviderChoice & { zeroDataRetention: boolean },
  env: Record<string, string | undefined> = process.env,
): JevClient {
  if (providerFor(cfg, env) === "typesafe") {
    const apiKey = env.TYPESAFE_API_KEY;
    if (!apiKey) throw new Error("provider = typesafe needs TYPESAFE_API_KEY");
    return typesafeClient({ apiKey });
  }
  // No key check here: the AI SDK also authenticates through a linked Vercel project
  // (`.vercel/project.json` + Vercel CLI login), and `hunch compile` relies on the same
  // lookup. Missing credentials surface as the SDK's own authentication error.
  return gatewayClient({ zeroDataRetention: cfg.zeroDataRetention });
}
