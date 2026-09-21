import { expect, test } from "bun:test";
import { clientFromEnv, providerFor, typesafeBaseUrl, typesafeClient } from "../src/jev.js";
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

test("the TypeSafe base url defaults to TypeSafe and is redirected by the environment", () => {
  expect(typesafeBaseUrl({})).toBe("https://api.typesafe.ai/v1");
  // OpenRouter serves Jev at the same /systemone path, so a base url is the whole difference.
  expect(typesafeBaseUrl({ TYPESAFE_BASE_URL: "https://openrouter.ai/api/v1" })).toBe("https://openrouter.ai/api/v1");
  // A copied url often keeps its trailing slash; it must not become a double slash in the path.
  expect(typesafeBaseUrl({ TYPESAFE_BASE_URL: "https://openrouter.ai/api/v1/" })).toBe("https://openrouter.ai/api/v1");
  // Blank is absent, not an instruction to send the key to a relative path.
  expect(typesafeBaseUrl({ TYPESAFE_BASE_URL: "  " })).toBe("https://api.typesafe.ai/v1");
});

test("a base url that is not an absolute http(s) address is refused rather than sent a key", () => {
  for (const bad of ["/v1", "openrouter.ai/api/v1", "file:///etc/passwd", "ftp://example.com"]) {
    expect(() => typesafeBaseUrl({ TYPESAFE_BASE_URL: bad })).toThrow("TYPESAFE_BASE_URL");
  }
  // The same refusal reaches anyone constructing a client from the environment.
  const typesafe = parseConfig({ provider: "typesafe" }, "t");
  expect(() => clientFromEnv(typesafe, { TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: "nope" })).toThrow("TYPESAFE_BASE_URL");
});

test("a redirected client reaches OpenRouter's decisions endpoint and reads its answer", async () => {
  const seen: { url?: string; authorization?: string; body?: unknown } = {};
  const client = typesafeClient({
    apiKey: "sk-or-v1-test",
    baseUrl: typesafeBaseUrl({ TYPESAFE_BASE_URL: "https://openrouter.ai/api/v1" }),
    fetch: (async (url: string, init: RequestInit) => {
      seen.url = String(url);
      seen.authorization = (init.headers as Record<string, string>).authorization;
      seen.body = JSON.parse(init.body as string);
      // OpenRouter's own shape: TypeSafe's fields plus `provider`, `usage.cost` and `output_tokens`.
      return new Response(
        JSON.stringify({
          model: "typesafe/jev-1.13-20260917",
          provider: "TypeSafe",
          answers: { swallowed: { type: "noul", noul: 0.99 } },
          usage: { input_tokens: 456, output_tokens: 81, cost: 1.9152e-5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch,
  });

  const result = await client.evaluate({
    model: "typesafe/jev-1.13",
    state: { code: "try { f() } catch {}" },
    questions: { swallowed: { type: "noul", instructions: "Is an error swallowed?" } },
  });

  expect(seen.url).toBe("https://openrouter.ai/api/v1/systemone");
  expect(seen.authorization).toBe("Bearer sk-or-v1-test");
  expect(seen.body).toMatchObject({ model: "typesafe/jev-1.13" });
  // Fields OpenRouter adds are ignored, and the answer is the one hunch already knows how to score.
  expect(result.answers.swallowed).toEqual({ type: "noul", p: 0.99 });
  expect(result.usage.inputTokens).toBe(456);
  expect(result.modelId).toBe("typesafe/jev-1.13-20260917");
});
