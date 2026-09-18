import { verify } from "@octokit/webhooks-methods";
import { send } from "@vercel/queue";
import { jobFromEvent, type ReviewJob } from "../lib/events.js";

/** Acknowledge only after durable enqueue. The queue, not this invocation, owns the work. */
export async function webhook(req: Request, deps: { secret: string; enqueue: (job: ReviewJob, delivery: string) => Promise<unknown> }): Promise<Response> {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (Number(req.headers.get("content-length")) > 1_000_000) return new Response("Too large", { status: 413 });
  const body = await req.text();
  if (Buffer.byteLength(body) > 1_000_000) return new Response("Too large", { status: 413 });
  const signature = req.headers.get("x-hub-signature-256") ?? "";
  const valid = await verify(deps.secret, body, signature).catch(() => false);
  if (!valid) return new Response("Invalid signature", { status: 401 });
  const delivery = req.headers.get("x-github-delivery");
  if (!delivery || !/^[\w-]{1,200}$/.test(delivery)) return new Response("Missing delivery id", { status: 400 });
  let payload: unknown;
  try { payload = JSON.parse(body); } catch { return new Response("Invalid JSON", { status: 400 }); }
  const job = jobFromEvent(req.headers.get("x-github-event") ?? "", payload);
  if (!job) return new Response("Ignored", { status: 202 });
  try { await deps.enqueue({ ...job, deliveryId: delivery }, delivery); }
  catch { return new Response("Queue unavailable; redeliver this webhook", { status: 503 }); }
  return new Response("Queued", { status: 202 });
}

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return new Response("App is not configured", { status: 503 });
  return webhook(req, { secret, enqueue: (job, delivery) => send("hunch-reviews", job, { idempotencyKey: delivery, retentionSeconds: 86_400 }) });
}
export function GET(): Response { return new Response("Hunch webhook endpoint"); }
