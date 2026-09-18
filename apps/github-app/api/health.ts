import { parseConfig } from "../../../packages/core/src/index.js";

/** Imports the real engine, so a broken runtime bundle cannot claim healthy. */
export function GET(): Response {
  const githubApp = Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_PRIVATE_KEY && process.env.GITHUB_WEBHOOK_SECRET);
  const leaseStore = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
  return Response.json({ status: githubApp && leaseStore ? "configured" : "setup_required", provider: parseConfig({}, "health").provider, githubApp, leaseStore });
}
