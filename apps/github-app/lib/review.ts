import { check, clientFromEnv, findingKey, findingKeysIn, githubApi, githubRepoReader, LOCK_FILE, loadConfig, parseHunks, parseLock, planThreads, staleSources, summaryMarkdown, type Config, type JevClient } from "../../../packages/core/src/index.js";
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
}

const WRITERS = ["admin", "maintain", "write"];

/** Links for every open concern, including comments just posted. */
async function threadLinks(api: ReturnType<typeof githubApi>, repo: string, pr: number) {
  const { threads } = await api.reviewThreads(repo, pr);
  return new Map(threads.filter((t) => t.mine && !t.resolved).flatMap((t) => findingKeysIn(t.body).map((k) => [k, t.url] as const)));
}

/** Throws on failure so the durable queue retries, with a failed check visible meanwhile. */
export async function runReview(job: ReviewJob, deps: ReviewDeps): Promise<"skipped" | "done"> {
  const api = githubApi(deps.token, deps.apiBase);
  if (job.sender) {
    if (!WRITERS.includes(await api.permission(job.repo, job.sender))) return "skipped";
  }
  const readPull = async () => pullSchema.parse(await api.call("GET", `/repos/${job.repo}/pulls/${job.pr}`));
  const pull = await readPull();
  if (pull.state !== "open" || pull.draft || (job.headSha && pull.head.sha !== job.headSha)) return "skipped";
  const baseSha = pull.base.sha;
  const headSha = pull.head.sha;
  const base = githubRepoReader(api, job.repo, baseSha);
  const loaded = await loadConfig(base).then((value) => ({ value }), () => ({ error: true as const }));
  if ("value" in loaded && !loaded.value) return "skipped";
  const { id } = await api.startCheck(job.repo, headSha, `hunch:${job.pr}:${baseSha}:${headSha}:${job.deliveryId ?? "local"}`, deps.appId);
  try {
    if ("error" in loaded) throw new Error("Base branch configuration is invalid");
    const { config } = loaded.value!;
    if (pull.changed_files > 300) throw new Error("PR exceeds GitHub's 300-file comparison limit; split this PR before review");
    const text = await base.read(LOCK_FILE);
    const lock = text ? parseLock(text) : null;
    const stale = await staleSources(lock, config, base);
    const diff = await api.compareDiff(job.repo, baseSha, headSha);
    if (diff == null) throw new Error("Immutable comparison unavailable");
    // The hosted worker has a 300-second limit; repository budgets can't raise these.
    const budget = { ...config.budget, maxHunks: Math.min(config.budget.maxHunks, 200), maxRequests: Math.min(config.budget.maxRequests, 100), timeoutSeconds: Math.min(config.budget.timeoutSeconds, 180) };
    const result = await check({ config: { ...config, budget }, hunks: parseHunks(diff), task: `${pull.title}\n\n${pull.body ?? ""}`, lock, client: (deps.jev ?? clientFromEnv)(config), readFile: (p) => base.read(p) });
    if (stale.length) { result.complete = false; result.notices.push(`Guidance is uncompiled or stale: ${stale.join(", ")}. Run hunch compile and review hunch.lock.`); }
    if (/^(?:Binary files |GIT binary patch|rename from |old mode )/m.test(diff)) { result.complete = false; result.notices.push("Binary, rename metadata or mode changes require human review."); }
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
  } catch {
    // Never publish raw provider errors, source snippets, tokens or private API bodies.
    await api.failCheck(job.repo, id, "Review could not complete. Check the base configuration, guidance lock, provider credentials/quota and PR size, then retry with /hunch recheck.");
    throw new Error("Hunch review failed; safe to retry");
  }
}
