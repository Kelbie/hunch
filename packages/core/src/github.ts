import type { CheckResult } from "./check.js";
import type { RepoReader } from "./load/index.js";
import { repoPath } from "./path.js";
import { reviewComment, STICKY_MARKER, toAnnotations } from "./report.js";
import type { Finding } from "./check.js";
import type { ReviewThread } from "./threads.js";

export function githubApi(token: string, baseUrl = "https://api.github.com") {
  const call = async <T>(method: string, path: string, body?: unknown, accept = "application/vnd.github+json"): Promise<T> => {
    const res = await fetch(`${baseUrl}${path}`, {
      method, signal: AbortSignal.timeout(30_000),
      headers: { accept, authorization: `Bearer ${token}`, "user-agent": "hunch", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404 && method === "GET") return null as T;
    if (!res.ok) throw Object.assign(new Error(`GitHub ${method} request failed (HTTP ${res.status})`), { status: res.status });
    const text = await res.text();
    if (text.length > 16_000_000) throw new Error("GitHub response exceeds 16 MB review limit");
    return (accept.includes("diff") || accept.includes("raw") ? text : text ? JSON.parse(text) : null) as T;
  };
  const graphql = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    const res = await call<{ data?: T; errors?: unknown[] }>("POST", "/graphql", { query, variables });
    if (!res?.data || res.errors?.length) throw new Error("GitHub GraphQL request failed");
    return res.data;
  };
  return {
    call,
    /** Permission of a user on the repository, or "none". */
    async permission(repo: string, login: string) {
      const res = await call<{ permission: string } | null>("GET", `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`);
      return res?.permission ?? "none";
    },
    /** Inline review threads with who resolved them; `self` is this app's bot login. */
    async reviewThreads(repo: string, pr: number): Promise<{ self: string; threads: ReviewThread[] }> {
      const [owner, name] = repo.split("/");
      type Page = { viewer: { login: string }; repository: { pullRequest: { reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: { id: string; isResolved: boolean; resolvedBy: { login: string } | null; comments: { nodes: { body: string; url: string; viewerDidAuthor: boolean }[] } }[];
      } } | null } | null };
      const threads: ReviewThread[] = [];
      let self = "", after: string | null = null;
      for (let page = 0; page < 20; page++) {
        const data: Page = await graphql<Page>(`query($owner: String!, $name: String!, $pr: Int!, $after: String) {
          viewer { login }
          repository(owner: $owner, name: $name) { pullRequest(number: $pr) { reviewThreads(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { id isResolved resolvedBy { login } comments(first: 1) { nodes { body url viewerDidAuthor } } }
          } } }
        }`, { owner, name, pr, after });
        self = data.viewer.login;
        const connection = data.repository?.pullRequest?.reviewThreads;
        if (!connection) throw new Error("Pull request review threads unavailable");
        for (const t of connection.nodes) {
          const first = t.comments.nodes[0];
          if (first) threads.push({ id: t.id, resolved: t.isResolved, resolvedBy: t.resolvedBy?.login ?? null, body: first.body, url: first.url, mine: first.viewerDidAuthor });
        }
        if (!connection.pageInfo.hasNextPage) return { self, threads };
        after = connection.pageInfo.endCursor;
      }
      throw new Error("Review thread pagination limit reached");
    },
    /**
     * Posts findings as one review of inline comments. If GitHub rejects a location
     * (HTTP 422: not part of the diff), comments are retried one at a time and the
     * rejected groups are returned so the summary can still show them.
     */
    async postReview(repo: string, pr: number, headSha: string, groups: Finding[][], body: string): Promise<Finding[][]> {
      if (!groups.length) return [];
      const comments = groups.map(reviewComment);
      try {
        await call("POST", `/repos/${repo}/pulls/${pr}/reviews`, { commit_id: headSha, event: "COMMENT", body, comments });
        return [];
      } catch (e) {
        if ((e as { status?: number }).status !== 422) throw e;
      }
      const rejected: Finding[][] = [];
      for (const [i, comment] of comments.entries()) {
        try { await call("POST", `/repos/${repo}/pulls/${pr}/comments`, { commit_id: headSha, ...comment }); }
        catch (e) { if ((e as { status?: number }).status === 422) rejected.push(groups[i]!); else throw e; }
      }
      return rejected;
    },
    resolveThread: (threadId: string) => graphql("mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }", { id: threadId }),
    compareDiff: (repo: string, base: string, head: string) => call<string>("GET", `/repos/${repo}/compare/${base}...${head}`, undefined, "application/vnd.github.diff"),
    /** A report per immutable reviewed commit. Only edit comments owned by this app. */
    async upsertSticky(repo: string, pr: number, body: string, identity: { appId: number; headSha: string }) {
      const marker = `${STICKY_MARKER}\n<!-- head:${identity.headSha} -->`;
      body = body.replace(STICKY_MARKER, marker).slice(0, 60_000);
      for (let page = 1; page <= 20; page++) {
        const comments = await call<{ id: number; body?: string; performed_via_github_app?: { id: number } }[]>("GET", `/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
        const mine = comments?.find((c) => c.performed_via_github_app?.id === identity.appId && c.body?.startsWith(marker));
        if (mine) return call("PATCH", `/repos/${repo}/issues/comments/${mine.id}`, { body });
        if (!comments || comments.length < 100) return call("POST", `/repos/${repo}/issues/${pr}/comments`, { body });
      }
      throw new Error("Comment pagination limit reached; refusing to create a duplicate report");
    },
    async startCheck(repo: string, headSha: string, externalId: string, appId: number) {
      const checks = await call<{ check_runs: { id: number; external_id: string; app: { id: number } }[] }>("GET", `/repos/${repo}/commits/${headSha}/check-runs?check_name=hunch&per_page=100&filter=all`);
      const existing = checks?.check_runs.find((c) => c.external_id === externalId && c.app.id === appId);
      return existing ?? call<{ id: number }>("POST", `/repos/${repo}/check-runs`, { name: "hunch", head_sha: headSha, external_id: externalId, status: "in_progress" });
    },
    async finishCheck(repo: string, checkId: number, result: CheckResult, opts: { summary: string; failOnError: boolean }) {
      const annotations = toAnnotations(result.findings);
      const hasError = result.findings.some((f) => f.level === "error");
      const conclusion = opts.failOnError && hasError ? "failure" : !result.complete || result.findings.length ? "neutral" : "success";
      const title = !result.complete ? "Partial review — see coverage" : result.findings.length ? `${result.findings.length} finding(s)` : "No findings in reviewed changes";
      for (let i = 0; i < Math.max(annotations.length, 1); i += 50) {
        await call("PATCH", `/repos/${repo}/check-runs/${checkId}`, {
          output: { title, summary: opts.summary.slice(0, 60_000), annotations: annotations.slice(i, i + 50) },
          ...(i + 50 >= annotations.length ? { status: "completed", conclusion } : {}),
        });
      }
    },
    failCheck: (repo: string, checkId: number, message: string) => call("PATCH", `/repos/${repo}/check-runs/${checkId}`, {
      status: "completed", conclusion: "failure", output: { title: "Hunch could not complete", summary: message.slice(0, 60_000) },
    }),
    supersedeCheck: (repo: string, checkId: number) => call("PATCH", `/repos/${repo}/check-runs/${checkId}`, {
      status: "completed", conclusion: "cancelled", output: { title: "Superseded by a newer PR revision", summary: "A newer revision needs a separate review." },
    }),
  };
}

/** Immutable Git tree; refuse symlinks rather than interpreting API dereferences. */
export function githubRepoReader(api: ReturnType<typeof githubApi>, repo: string, ref: string): RepoReader {
  type Entry = { path: string; type: string; mode?: string };
  let cached: Promise<Entry[]> | undefined;
  const tree = () => cached ??= api.call<{ truncated?: boolean; tree: Entry[] }>("GET", `/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`).then((r) => {
    if (!r || r.truncated) throw new Error("GitHub tree is missing or truncated; cannot determine guidance coverage");
    return r.tree;
  });
  return {
    async read(path) {
      path = repoPath(path);
      const entry = (await tree()).find((e) => e.path === path);
      if (!entry) return null;
      if (entry.mode === "120000" || entry.type !== "blob") throw new Error(`Guidance must be a regular file: ${path}`);
      return api.call<string | null>("GET", `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`, undefined, "application/vnd.github.raw");
    },
    async list(dir) {
      const prefix = `${repoPath(dir)}/`;
      return (await tree()).filter((e) => e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes("/")).map((e) => {
        if (e.mode === "120000") throw new Error(`Install committed skill copies instead of symlinks: ${e.path}`);
        return { name: e.path.slice(prefix.length), type: e.type === "tree" ? "dir" as const : "file" as const };
      });
    },
    async files() { return (await tree()).filter((e) => e.type === "blob").map((e) => e.path).sort(); },
  };
}
