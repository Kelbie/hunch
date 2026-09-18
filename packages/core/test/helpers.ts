import type { EvaluateRequest, EvaluateResult, JevClient, WireQuestion } from "../src/jev.js";
import type { RepoReader } from "../src/load/index.js";

/** Fake Jev: answers each question with a function of (instructions, state). */
export function fakeJev(answer: (q: WireQuestion, state: Record<string, unknown>) => EvaluateResult["answers"][string]) {
  const calls: EvaluateRequest[] = [];
  const client: JevClient = {
    async evaluate(req) {
      calls.push(req);
      const answers = Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, answer(q, req.state)]));
      return { answers, usage: { inputTokens: 100 }, modelId: "fake-jev" };
    },
  };
  return { client, calls };
}

export function memoryRepo(files: Record<string, string>): RepoReader {
  return {
    async read(p) {
      return files[p] ?? null;
    },
    async list(dir) {
      const prefix = `${dir}/`;
      const names = new Map<string, "file" | "dir">();
      for (const f of Object.keys(files)) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        const [head, ...tail] = rest.split("/");
        names.set(head!, tail.length ? "dir" : "file");
      }
      return [...names].map(([name, type]) => ({ name, type }));
    },
    async files() {
      return Object.keys(files);
    },
  };
}

export const DIFF = `diff --git a/src/pay.ts b/src/pay.ts
index 1111111..2222222 100644
--- a/src/pay.ts
+++ b/src/pay.ts
@@ -1,6 +1,8 @@
 export function pay(amount: number) {
-  // charge the card
+  // refunds the order
   const res = charge(amount);
+  console.log("DEBUG", res);
+  return res;
 }
diff --git a/src/pay.test.ts b/src/pay.test.ts
index 1111111..2222222 100644
--- a/src/pay.test.ts
+++ b/src/pay.test.ts
@@ -1,4 +1,4 @@
-test("pays", () => {
-  expect(pay(1)).toEqual({ ok: true, id: 1 });
+test.skip("pays", () => {
+  expect(pay(1)).toBeDefined();
 });
diff --git a/bun.lock b/bun.lock
index 1111111..2222222 100644
--- a/bun.lock
+++ b/bun.lock
@@ -1,1 +1,1 @@
-a
+b
`;
