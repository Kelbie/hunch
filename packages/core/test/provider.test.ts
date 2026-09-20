import { expect, test } from "bun:test";
import { clientFromEnv, providerFor } from "../src/jev.js";
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
