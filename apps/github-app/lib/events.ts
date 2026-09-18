import { z } from "zod";

export const reviewJobSchema = z.object({
  installationId: z.number().int().positive(),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  pr: z.number().int().positive(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  sender: z.string().regex(/^[\w-]+$/).optional(),
  deliveryId: z.string().min(1).max(200).optional(),
});
export type ReviewJob = z.infer<typeof reviewJobSchema>;
const envelope = z.object({ installation: z.object({ id: z.number() }), repository: z.object({ full_name: z.string() }), action: z.string() }).passthrough();
const pullSchema = z.object({ number: z.number(), draft: z.boolean(), state: z.string(), head: z.object({ sha: z.string() }) });
export const RECHECK_COMMAND = /^\s*\/hunch recheck\s*$/;

/** Validate public webhook payloads before they can create paid work. */
export function jobFromEvent(event: string, payload: unknown): ReviewJob | null {
  const parsed = envelope.safeParse(payload);
  if (!parsed.success) return null;
  const p = parsed.data;
  const common = { installationId: p.installation.id, repo: p.repository.full_name };
  let job: unknown;
  if (event === "pull_request" && ["opened", "synchronize", "reopened", "ready_for_review", "edited"].includes(p.action)) {
    const pull = pullSchema.safeParse(p.pull_request);
    if (!pull.success || pull.data.draft || pull.data.state !== "open") return null;
    job = { ...common, pr: pull.data.number, headSha: pull.data.head.sha };
  } else if (event === "issue_comment" && p.action === "created") {
    const comment = z.object({ body: z.string() }).safeParse(p.comment);
    const issue = z.object({ number: z.number(), pull_request: z.object({}).passthrough() }).safeParse(p.issue);
    const sender = z.object({ login: z.string() }).safeParse(p.sender);
    if (!comment.success || !issue.success || !sender.success || !RECHECK_COMMAND.test(comment.data.body)) return null;
    // Actual write permission is checked with GitHub, not author_association.
    job = { ...common, pr: issue.data.number, sender: sender.data.login };
  } else return null;
  const result = reviewJobSchema.safeParse(job);
  return result.success ? result.data : null;
}
