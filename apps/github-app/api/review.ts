import { createAppAuth } from "@octokit/auth-app";
import { handleCallback } from "@vercel/queue";
import { reviewJobSchema } from "../lib/events.js";
import { redisLeaseStore, withReviewLease } from "../lib/lease.js";
import { dailyReviewLimit, redisQuota } from "../lib/quota.js";
import { runReview } from "../lib/review.js";

/** Queue deliveries per review: first try plus retries at 30s, 1m, 2m and 4m. */
const MAX_ATTEMPTS = 5;

export const POST = handleCallback(async (message: unknown, metadata) => {
  const job = reviewJobSchema.parse(message);
  const appId = Number(process.env.GITHUB_APP_ID);
  const privateKey = process.env.GITHUB_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!Number.isSafeInteger(appId) || appId <= 0 || !privateKey) throw new Error("GitHub App credentials not configured");
  const auth = createAppAuth({ appId, privateKey });
  const { token } = await auth({ type: "installation", installationId: job.installationId, repositoryNames: [job.repo.split("/")[1]!] });
  const limit = dailyReviewLimit();
  const quota = limit === null ? undefined : redisQuota(limit);
  await withReviewLease(`${job.repo}:${job.pr}`, redisLeaseStore(), () => runReview(job, {
    token, appId, attempt: metadata.deliveryCount, maxAttempts: MAX_ATTEMPTS,
    ...(quota ? { quota: (unit: string) => quota.consume(job.installationId, unit) } : {}),
  }));
}, { retry: (_error, metadata) => ({ afterSeconds: Math.min(3600, 30 * 2 ** Math.min(metadata.deliveryCount, 7)) }) });
