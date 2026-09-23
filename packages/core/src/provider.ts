import { gatewayClient, isExhaustedError, typesafeClient, type JevClient } from "./jev.js";
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
 * The providers to try, in order, and how a run says which one answered.
 *
 * A key that has expired, run out of credit, cannot meet the retention policy, or is being rate
 * limited refuses every request alike, so a run that has answered nothing yet has nothing to lose
 * by trying the next provider. Once anything has been answered the offer expires: one review judged
 * half by one model and half by another would be a worse result than a failed one, and harder to
 * notice.
 */
export interface Fallback {
  /** Providers in the order to try them. The first is the one the run asked for. */
  chain: readonly { name: Provider; open: () => Promise<JevClient> | JevClient }[];
  /** Which failures every request would meet alike. Exhausted providers, unless a caller knows better. */
  shouldSwitch?: (error: unknown) => boolean;
  /** Told before the next provider is opened, so a run never changes model without saying so. */
  onSwitch: (from: Provider, to: Provider, error: unknown) => void;
}

export function clientWithFallback(opts: Fallback): ClosableClient {
  if (!opts.chain.length) throw new Error("A run needs at least one provider to ask.");
  const shouldSwitch = opts.shouldSwitch ?? isExhaustedError;
  const open: Promise<JevClient>[] = [];
  let at = 0;
  let current: Promise<JevClient> | undefined;
  let answered = false;
  const start = () => {
    const built = (async () => opts.chain[at]!.open())();
    open.push(built);
    return (current = built);
  };
  return {
    async evaluate(req) {
      for (;;) {
        try {
          const result = await (current ?? start()).then((client) => client.evaluate(req));
          answered = true;
          return result;
        } catch (error) {
          // Nothing has been answered and there is somewhere else to ask: the whole run moves.
          if (answered || at + 1 >= opts.chain.length || !shouldSwitch(error)) throw error;
          opts.onSwitch(opts.chain[at]!.name, opts.chain[at + 1]!.name, error);
          at += 1;
          start();
        }
      }
    },
    close() {
      // Only the ones that were opened: a provider that was never reached holds nothing.
      for (const client of open) void client.then(closeClient, () => {});
    },
  };
}
