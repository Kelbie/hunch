import { expect, test } from "bun:test";
import { clientFromEnv, providerFor } from "../src/provider.js";
import { parseConfig } from "../src/schema.js";

test("a config that names no provider uses the credentials this machine holds", () => {
  const unset = parseConfig({}, "t");
  // Someone who signed in with a TypeSafe key can review any repository, configured or not.
  expect(providerFor(unset, { TYPESAFE_API_KEY: "k" })).toBe("typesafe");
  // The hosted App and CI hold no TypeSafe key, so they stay on the Gateway as before.
  expect(providerFor(unset, {})).toBe("gateway");
  expect(providerFor(unset, { AI_GATEWAY_API_KEY: "g" })).toBe("gateway");
  // With both keys, nothing changes for setups that predate this choice.
  expect(providerFor(unset, { AI_GATEWAY_API_KEY: "g", TYPESAFE_API_KEY: "k" })).toBe("gateway");
});

test("a provider the config names is never overridden by what happens to be signed in", () => {
  const gateway = parseConfig({ provider: "gateway" }, "t");
  expect(providerFor(gateway, { TYPESAFE_API_KEY: "k" })).toBe("gateway");
  const typesafe = parseConfig({ provider: "typesafe" }, "t");
  expect(providerFor(typesafe, { AI_GATEWAY_API_KEY: "g" })).toBe("typesafe");
  // Naming TypeSafe without its key is still an error to fix, not a silent switch to the Gateway.
  expect(() => clientFromEnv(typesafe, { AI_GATEWAY_API_KEY: "g" })).toThrow("TYPESAFE_API_KEY");
});

test("SemIf is chosen only when this machine set it up and nothing hosted is signed in", () => {
  const unset = parseConfig({}, "t");
  expect(providerFor(unset, { SEMIF_MODEL: "Qwen/Qwen3.5-4B" })).toBe("semif");
  // An install that costs nothing to have must not take a working Gateway sign-in away.
  expect(providerFor(unset, { SEMIF_MODEL: "Qwen/Qwen3.5-4B", AI_GATEWAY_API_KEY: "g" })).toBe("gateway");
  // A TypeSafe key is a deliberate sign-in too, and predates this one.
  expect(providerFor(unset, { SEMIF_MODEL: "Qwen/Qwen3.5-4B", TYPESAFE_API_KEY: "k" })).toBe("typesafe");
  // Nothing set up: unchanged for the hosted App and CI.
  expect(providerFor(unset, {})).toBe("gateway");
});

test("a config or a flag that names SemIf is obeyed, and needs no key at all", () => {
  const semif = parseConfig({ provider: "semif" }, "t");
  expect(providerFor(semif, { AI_GATEWAY_API_KEY: "g", TYPESAFE_API_KEY: "k" })).toBe("semif");
  // Building the client must not start a model: that happens on the first question.
  expect(clientFromEnv(semif, {})).toHaveProperty("evaluate");
});

import { clientWithFallback } from "../src/provider.js";
import type { EvaluateResult, JevClient } from "../src/jev.js";

const ASKED = { model: "m", state: { a: 1 }, questions: { q: { type: "noul" as const, instructions: "Is it?" } } };
const answer = (id: string): EvaluateResult => ({ answers: { q: { type: "noul", p: 0.5 } }, usage: { inputTokens: 1 }, modelId: id });
const refuses = (error: Error): JevClient => ({ evaluate: () => Promise.reject(error) });
const answers = (id: string): JevClient => ({ evaluate: () => Promise.resolve(answer(id)) });

test("a provider that refuses everything hands the run to the one that can finish it", async () => {
  const switches: unknown[] = [];
  const client = clientWithFallback({
    primary: () => refuses(new Error("Jev request failed (HTTP 402). Check provider credentials, quota and availability.")),
    alternative: () => answers("semif:local"),
    onSwitch: (e) => switches.push(e),
  });
  expect((await client.evaluate(ASKED)).modelId).toBe("semif:local");
  // Announced once, never quietly: a report that names another model must say why.
  expect(switches).toHaveLength(1);
  // The switch is made once, not per request.
  expect((await client.evaluate(ASKED)).modelId).toBe("semif:local");
  expect(switches).toHaveLength(1);
});

test("nothing signed in at all is still a refusal a local model can answer", async () => {
  const client = clientWithFallback({
    primary: () => { throw new Error("No authentication provided: no model key or Vercel project is signed in on this machine."); },
    alternative: () => answers("semif:local"),
    onSwitch: () => {},
  });
  expect((await client.evaluate(ASKED)).modelId).toBe("semif:local");
});

test("an ordinary failure is the caller's to handle, and one review is never judged by two models", async () => {
  const switches: unknown[] = [];
  const flaky: JevClient = {
    evaluate: (() => {
      let n = 0;
      return () => (++n === 1 ? Promise.resolve(answer("gateway")) : Promise.reject(new Error("Jev request failed (HTTP 402).")));
    })(),
  };
  const client = clientWithFallback({ primary: () => flaky, alternative: () => answers("semif:local"), onSwitch: (e) => switches.push(e) });
  expect((await client.evaluate(ASKED)).modelId).toBe("gateway");
  // It answered once, so the rest of this review belongs to it, failures included.
  await expect(client.evaluate(ASKED)).rejects.toThrow("HTTP 402");
  expect(switches).toEqual([]);

  const timeout = clientWithFallback({
    primary: () => refuses(new Error("The operation was aborted due to timeout")),
    alternative: () => answers("semif:local"),
    onSwitch: (e) => switches.push(e),
  });
  await expect(timeout.evaluate(ASKED)).rejects.toThrow("timeout");
  expect(switches).toEqual([]);
});

test("a caller that never asked anything closes nothing", () => {
  let built = 0;
  clientWithFallback({ primary: () => { built++; return answers("x"); }, alternative: () => answers("y"), onSwitch: () => {} }).close();
  expect(built).toBe(0);
});
