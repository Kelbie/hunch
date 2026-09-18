import type { ChoiceQuestion, ConfigInput, NoulQuestion, ScoreQuestion } from "./schema.js";

/**
 * Authoring helpers for `hunch.config.ts`. They only tag plain data, so the
 * hosted app can evaluate the same file statically without running it.
 */
type Opts<Q> = Omit<Partial<Q>, "kind" | "when"> & { instructions: string };

export function defineConfig(config: ConfigInput): ConfigInput {
  return config;
}

export function noul(q: Opts<NoulQuestion> & { when?: RegExp | string }) {
  return { kind: "noul" as const, ...q };
}

export function choice<const C extends Record<string, string>>(
  q: Omit<Opts<ChoiceQuestion>, "criteria" | "report"> & { criteria: C; report: (keyof C & string)[]; when?: RegExp | string },
) {
  return { kind: "choice" as const, ...q };
}

export function score(q: Opts<ScoreQuestion> & { criteria: string[]; when?: RegExp | string }) {
  return { kind: "score" as const, ...q };
}

/** Names the static evaluator treats as tagging helpers. */
export const HELPERS = { defineConfig, noul, choice, score } as const;
