import { check, clientFromEnv, githubApi, githubRepoReader, LOCK_FILE, loadConfig, parseHunks, parseLock, staleSources, summaryMarkdown, type Config, type JevClient } from "../../../packages/core/src/index.js";
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

/** Throws on failure so the durable queue retries, with a failed check visible meanwhile. */
export async function runReview(job: ReviewJob, deps: ReviewDeps): Promise<"skipped" | "done"> {
  const api = githubApi(deps.token, deps.apiBase);
  if (job.sender) {
    const permission = await api.call<{ permission: string } | null>("GET", `/repos/${job.repo}/collaborators/${encodeURIComponent(job.sender)}/permission`);
    if (!permission || !["admin", "maintain", "write"].includes(permission.permission)) return "skipped";
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
    const result = await check({ config, hunks: parseHunks(diff), task: `${pull.title}\n\n${pull.body ?? ""}`, lock, client: (deps.jev ?? clientFromEnv)(config), readFile: (p) => base.read(p) });
    if (stale.length) { result.complete = false; result.notices.push(`Guidance is uncompiled or stale: ${stale.join(", ")}. Run hunch compile and review hunch.lock.`); }
    if (/^(?:Binary files |GIT binary patch|rename from |old mode )/m.test(diff)) { result.complete = false; result.notices.push("Binary, rename metadata or mode changes require human review."); }
    const latest = await readPull();
    if (latest.state !== "open" || latest.draft || latest.head.sha !== headSha || latest.base.sha !== baseSha) {
      await api.supersedeCheck(job.repo, id);
      return "skipped";
    }
    const summary = summaryMarkdown(result, { blobBase: `https://github.com/${job.repo}/blob/${headSha}` });
    // Comment first: failure must not leave a successful check for an unpublished report.
    await api.upsertSticky(job.repo, job.pr, summary, { appId: deps.appId, headSha });
    await api.finishCheck(job.repo, id, result, { summary, failOnError: config.failOnError });
    deps.log?.(`${job.repo}#${job.pr}: reviewed ${headSha.slice(0, 7)}`);
    return "done";
  } catch {
    // Never publish raw provider errors, source snippets, tokens or private API bodies.
    await api.failCheck(job.repo, id, "Review could not complete. Check the base configuration, guidance lock, provider credentials/quota and PR size, then retry with /hunch recheck.");
    throw new Error("Hunch review failed; safe to retry");
  }
}
