import type { Finding } from "./check.js";
import { anchorLine, findingKey, findingKeysIn, threadKey } from "./report.js";

/** An inline review thread on the PR, as GitHub reports it. */
export interface ReviewThread {
  id: string;
  resolved: boolean;
  /** Login of whoever resolved it, if anyone. */
  resolvedBy: string | null;
  /** First comment. */
  body: string;
  url: string;
  /** The line the thread is anchored to, or null when GitHub can't place it. */
  line: number | null;
  /** The first comment was written by this app. Only these threads are trusted. */
  mine: boolean;
}

export interface ThreadPlan {
  /** Findings still to report: new, still open, or resolved by someone who can't dismiss them. */
  active: Finding[];
  /** Findings dismissed by someone allowed to. */
  dismissed: Finding[];
  /** Active findings without a thread, grouped by location, one inline comment each. */
  post: Finding[][];
  /** Open threads whose concerns were not raised again. */
  resolve: ReviewThread[];
  /** Thread URL per exact `threadKey`, for summary links. */
  links: Map<string, string>;
}

/**
 * Reconciles this revision's findings with the app's earlier inline threads.
 * A concern is a rule in a file. Resolving its thread dismisses it for the PR,
 * but only when `canDismiss` accepts the resolver; the app resolving its own
 * thread means "fixed", so a concern that comes back gets a new comment.
 * Open threads are only closed as fixed after a complete review.
 */
export function planThreads(findings: Finding[], threads: ReviewThread[], opts: { self: string; canDismiss: (login: string) => boolean; complete: boolean }): ThreadPlan {
  const byKey = new Map<string, ReviewThread>();
  for (const t of threads) if (t.mine) for (const key of findingKeysIn(t.body)) {
    const prev = byKey.get(key);
    // Prefer a thread that is still in play over one the app closed as fixed.
    if (!prev || resolvedBySelf(prev, opts.self)) byKey.set(key, t);
  }
  const plan: ThreadPlan = { active: [], dismissed: [], post: [], resolve: [], links: new Map() };
  const unposted: Finding[] = [];
  for (const f of findings) {
    const key = findingKey(f);
    const t = byKey.get(key);
    if (t?.resolved && t.resolvedBy && t.resolvedBy !== opts.self && opts.canDismiss(t.resolvedBy)) { plan.dismissed.push(f); continue; }
    plan.active.push(f);
    const here = threads.find(x => x.mine && !resolvedBySelf(x, opts.self) && x.line === anchorLine(f) && findingKeysIn(x.body).includes(key));
    if (!here) unposted.push(f);
    else plan.links.set(threadKey(f), here.url);
  }
  plan.post = [...Map.groupBy(unposted, f => JSON.stringify([f.file, f.line, f.endLine])).values()];
  if (opts.complete) {
    const raised = new Set(findings.map(threadKey));
    plan.resolve = threads.filter(t => t.mine && !t.resolved && findingKeysIn(t.body).length && !findingKeysIn(t.body).some(k => raised.has(`${k}@${t.line}`)));
  }
  return plan;
}

const resolvedBySelf = (t: ReviewThread, self: string) => t.resolved && t.resolvedBy === self;
