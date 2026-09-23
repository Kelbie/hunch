import { gatewayClient, isSetupError, typesafeClient, type JevClient } from "./jev.js";
import { closeClient, semifClient, semifSettings, type ClosableClient, type SemifConfig } from "./semif.js";

/** The three ways to reach a semantic model. `gateway` and `typesafe` are Jev; `semif` is local. */
export const PROVIDERS = ["gateway", "typesafe", "semif"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const isProvider = (value: string): value is Provider => (PROVIDERS as readonly string[]).includes(value);

type ProviderChoice = { provider?: Provider; semif?: SemifConfig };

/**
 * The provider a run uses. A config that names one is obeyed. One that does not leaves it to the
 * credentials at hand, so a person signed in with a TypeSafe key, or with SemIf set up on this
 * machine, can review a repository that has no Hunch config, while the hosted App and CI, which
 * hold neither, stay on the Gateway.
 */
export function providerFor(cfg: ProviderChoice, env: Record<string, string | undefined> = process.env): Provider {
  if (cfg.provider) return cfg.provider;
  if (env.TYPESAFE_API_KEY && !env.AI_GATEWAY_API_KEY) return "typesafe";
  // Only an explicit SemIf setup counts: it costs nothing to have installed, so it must not quietly
  // replace a Gateway sign-in that is already working.
  if (env.SEMIF_MODEL && !env.AI_GATEWAY_API_KEY) return "semif";
  return "gateway";
}

export function clientFromEnv(
  cfg: ProviderChoice & { zeroDataRetention: boolean },
  env: Record<string, string | undefined> = process.env,
): JevClient {
  const provider = providerFor(cfg, env);
  if (provider === "semif") return semifClient(semifSettings(cfg.semif, env));
  if (provider === "typesafe") {
    const apiKey = env.TYPESAFE_API_KEY;
    if (!apiKey) throw new Error("provider = typesafe needs TYPESAFE_API_KEY");
    return typesafeClient({ apiKey });
  }
  // No key check here: the AI SDK also authenticates through a linked Vercel project
  // (`.vercel/project.json` + Vercel CLI login), and `hunch install` relies on the same
  // lookup. Missing credentials surface as the SDK's own authentication error.
  return gatewayClient({ zeroDataRetention: cfg.zeroDataRetention });
}

/**
 * One provider, and the one to finish on when it will not answer at all.
 *
 * A key that has expired, run out of credit or cannot meet the retention policy refuses every
 * request alike, so a run that has answered nothing yet has nothing to lose by starting again
 * somewhere else. Once anything has been answered the offer expires: one review judged half by one
 * model and half by another would be a worse result than a failed one, and harder to notice.
 */
export interface FallbackOptions {
  /** The provider the run asked for. It may fail here, before a question is ever sent. */
  primary: () => Promise<JevClient> | JevClient;
  /** Built at most once, and only in place of a provider that answered nothing. */
  alternative: () => Promise<JevClient> | JevClient;
  /** Which failures every request would meet alike. Setup failures, unless a caller knows better. */
  shouldSwitch?: (error: unknown) => boolean;
  /** Told before the alternative is built, so a run never changes model without saying so. */
  onSwitch: (error: unknown) => void;
}

export function clientWithFallback(opts: FallbackOptions): ClosableClient {
  const shouldSwitch = opts.shouldSwitch ?? isSetupError;
  let current: Promise<JevClient> | undefined;
  let answered = false;
  let switched: Promise<JevClient> | undefined;
  const open: Promise<JevClient>[] = [];
  const start = (make: FallbackOptions["primary"]) => {
    const built = (async () => make())();
    open.push(built);
    return built;
  };
  return {
    async evaluate(req) {
      try {
        const result = await (current ??= start(opts.primary)).then((client) => client.evaluate(req));
        answered = true;
        return result;
      } catch (error) {
        if (answered || switched || !shouldSwitch(error)) throw error;
        opts.onSwitch(error);
        current = switched = start(opts.alternative);
        const result = await (await switched).evaluate(req);
        answered = true;
        return result;
      }
    },
    close() {
      // Both, and only the ones that were built: a provider that was never reached holds nothing.
      for (const client of open) void client.then(closeClient, () => {});
    },
  };
}
