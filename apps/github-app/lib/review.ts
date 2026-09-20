import { check, clientFromEnv, ConfigError, inScope, unreviewableFiles, findingKey, findingKeysIn, githubApi, githubRepoReader, LOCK_FILE, loadConfig, parseHunks, parseLock, planThreads, staleSources, summaryMarkdown, type Config, type JevClient } from "../../../packages/core/src/index.js";
import { z } from "zod";
import type { ReviewJob } from "./events.js";

const pullSchema = z.object({
  state: z.string(), draft: z.boolean(), title: z.string(), body: z.string().nullable(), changed_files: z.number(),
  base: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }), head: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }),
});
export interface ReviewDeps {
  token: string; appId: number; apiBase?: string;
  jev?: (config: Config) => JevClient;
  log?: (msg: string) => void;
  /** Charges this installation for the review, already bound to it. Absent means unlimited. */
  quota?: (unit: string) => Promise<{ allowed: boolean; limit: number }>;
  /** This delivery's number (from 1) and how many the queue gets before Hunch gives up. */
  attempt?: number;
  maxAttempts?: number;
  /** Wait between GitHub API retries; tests skip it. */
  sleep?: (ms: number) => Promise<void>;
}

/** A failure retrying can't fix. Its message is written by Hunch and safe to publish. */
class PermanentError extends Error {}

const WRITERS = ["admin", "maintain", "write"];

/** Links for every open concern, including comments just posted. */
async function threadLinks(api: ReturnType<typeof githubApi>, repo: string, pr: number) {
  const { threads } = await api.reviewThreads(repo, pr);
  const open = threads.filter((t) => t.mine && !t.resolved);
  // Per place first; per rule and file as a fallback, keeping the first thread.
  return new Map([...open.flatMap((t) => findingKeysIn(t.body).map((k) => [k, t.url] as const)).reverse(),
    ...open.flatMap((t) => findingKeysIn(t.body).map((k) => [`${k}@${t.line}`, t.url] as const))]);
}

/**
 * Throws on a temporary failure so the durable queue retries; meanwhile the check
 * says it is retrying. Only the last attempt, or a failure retrying can't fix,
 * marks the check failed, and then the job is acknowledged instead of retried.
 */
export async function runReview(job: ReviewJob, deps: ReviewDeps): Promise<"skipped" | "done" | "failed"> {
  const api = githubApi(deps.token, deps.apiBase, { sleep: deps.sleep });
  if (job.sender) {
    if (!WRITERS.includes(await api.permission(job.repo, job.sender))) return "skipped";
  }
  const readPull = async () => pullSchema.parse(await api.call("GET", `/repos/${job.repo}/pulls/${job.pr}`));
  const pull = await readPull();
  if (pull.state !== "open" || pull.draft || (job.headSha && pull.head.sha !== job.headSha)) return "skipped";
  const baseSha = pull.base.sha;
  const headSha = pull.head.sha;
  const base = githubRepoReader(api, job.repo, baseSha);
  // Only an invalid config is permanent; a GitHub read failure is retried.
  const loaded = await loadConfig(base).then((value) => ({ value }), (e) => e instanceof ConfigError ? { error: true as const } : Promise.reject(e));
  if ("value" in loaded && !loaded.value) return "skipped";
  const { id } = await api.startCheck(job.repo, headSha, `hunch:${job.pr}:${baseSha}:${headSha}:${job.deliveryId ?? "local"}`, deps.appId);
  try {
    if ("error" in loaded) throw new PermanentError("The Hunch config on the base branch is invalid. Run `npx @kelbie/hunch config` locally to see why, fix it on the base branch, then comment /hunch recheck.");
    const { config } = loaded.value!;
    if (pull.changed_files > 300) throw new PermanentError("This PR changes more than 300 files, GitHub's comparison limit. Split it to get a review.");
    const text = await base.read(LOCK_FILE);
    let lock = null;
    try { lock = text ? parseLock(text) : null; }
    catch { throw new PermanentError("hunch.lock on the base branch is invalid. Run `npx @kelbie/hunch compile` and commit it, then comment /hunch recheck."); }
    const stale = await staleSources(lock, config, base);
    const diff = await api.compareDiff(job.repo, baseSha, headSha);
    if (diff == null) throw new Error("Immutable comparison unavailable");
    // Charged per head commit, so retries and redeliveries of this review are free.
    if (deps.quota) {
      const { allowed, limit } = await deps.quota(`${job.repo}:${job.pr}:${headSha}`);
      if (!allowed) throw new PermanentError(`This installation has used its ${limit} Hunch reviews for today. Reviews resume after 00:00 UTC. For unlimited reviews, run Hunch in your own CI or deployment: https://github.com/Kelbie/hunch#install`);
    }
    // The hosted worker has a 300-second limit, so time is the binding cap; 60 seconds stay free for publishing. Repository budgets can't raise these.
    const budget = { ...config.budget, maxHunks: Math.min(config.budget.maxHunks, 3000), maxRequests: Math.min(config.budget.maxRequests, 3000), timeoutSeconds: Math.min(config.budget.timeoutSeconds, 240), concurrency: Math.min(config.budget.concurrency, 8) };
    const head = githubRepoReader(api, job.repo, headSha);
    const result = await check({ config: { ...config, budget }, hunks: parseHunks(diff), task: `${pull.title}\n\n${pull.body ?? ""}`, lock, client: (deps.jev ?? clientFromEnv)(config), readFile: (p) => base.read(p), readChangedFile: (p) => head.read(p) });
    if (stale.length) { result.complete = false; result.notices.push(`Guidance is uncompiled or stale: ${stale.join(", ")}. Run hunch compile and review hunch.lock.`); }
    const unreviewable = unreviewableFiles(diff).filter(inScope(config));
      if (unreviewable.length) { result.complete = false; result.notices.push(`Binary, rename-only or mode changes need human review: ${unreviewable.join(", ")}.`); }
    const latest = await readPull();
    if (latest.state !== "open" || latest.draft || latest.head.sha !== headSha || latest.base.sha !== baseSha) {
      await api.supersedeCheck(job.repo, id);
      return "skipped";
    }
    // Inline threads carry each concern; resolving one dismisses it for this PR.
    const { self, threads } = await api.reviewThreads(job.repo, job.pr);
    const resolvers = [...new Set(threads.filter((t) => t.mine && t.resolved && t.resolvedBy && t.resolvedBy !== self).map((t) => t.resolvedBy!))];
    const writers = new Set<string>();
    for (const login of resolvers) if (WRITERS.includes(await api.permission(job.repo, login))) writers.add(login);
    const plan = planThreads(result.findings, threads, { self, canDismiss: (login) => writers.has(login), complete: result.complete });
    const newIssues = plan.post.length;
    const rejected = await api.postReview(job.repo, job.pr, headSha, plan.post,
      `🔮 **Hunch** raised ${newIssues === 1 ? "1 new concern" : `${newIssues} new concerns`} on \`${headSha.slice(0, 7)}\`. Resolve a comment to dismiss it.`);
    for (const t of plan.resolve) await api.resolveThread(t.id);
    const links = newIssues > rejected.length ? new Map([...plan.links, ...await threadLinks(api, job.repo, job.pr)]) : plan.links;
    const reported = { ...result, findings: plan.active };
    const summary = summaryMarkdown(reported, { blobBase: `https://github.com/${job.repo}/blob/${headSha}`, threads: links, dismissed: new Set(plan.dismissed.map(findingKey)).size, fixed: plan.resolve.length });
    // Comment first: failure must not leave a successful check for an unpublished report.
    await api.upsertSticky(job.repo, job.pr, summary, { appId: deps.appId, headSha });
    await api.finishCheck(job.repo, id, reported, { summary, failOnError: config.failOnError });
    deps.log?.(`${job.repo}#${job.pr}: reviewed ${headSha.slice(0, 7)}`);
    return "done";
  } catch (e) {
    // Never publish raw provider errors, source snippets, tokens or private API bodies.
    if (e instanceof PermanentError) {
      await api.failCheck(job.repo, id, e.message);
      return "failed";
    }
    const attempt = deps.attempt ?? 1, max = deps.maxAttempts ?? 1;
    if (attempt < max) {
      await api.retryingCheck(job.repo, id, attempt, max);
      throw new Error("Hunch review failed; safe to retry");
    }
    await api.failCheck(job.repo, id, `Review could not complete after ${plural(max, "attempt")}. This is usually a provider outage, quota or credentials problem. Comment /hunch recheck to try again.`);
    return "failed";
  }
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
