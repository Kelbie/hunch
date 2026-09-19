import { expect, test } from "bun:test";
import { fileHunks, hunkContext, languageOf, parseHunks, roleOf, toWire } from "../src/index.js";

const diff = (body: string) => parseHunks(body)[0]!;

const MODIFIED = `diff --git a/app/features/send/Send.tsx b/app/features/send/Send.tsx
--- a/app/features/send/Send.tsx
+++ b/app/features/send/Send.tsx
@@ -10,3 +10,3 @@
 const amount = useAmount();
-await pay(amount);
+await pay(Number(amount) || 0);
`;

test("a modified hunk is described as a change, with the mode, the language and the line range", () => {
  const text = hunkContext(diff(MODIFIED));
  expect(text).toContain("proposed code change");
  expect(text).toContain("`app/features/send/Send.tsx`, a TypeScript JSX file modified by this change");
  expect(text).toContain("lines 10–12");
  expect(text).toContain("Lines starting with `+` are the new code under review");
  expect(text).toContain("Lines starting with a space are unchanged code");
  expect(text).toContain("Pre-existing problems the change leaves untouched are not this review's concern.");
  // The answering rules appear once in `context`, not once per question.
  expect(text.match(/absent code is not evidence/g)).toHaveLength(1);
});

test("a whole-file chunk is never described as a change, because every line being `+` means the opposite there", () => {
  const [chunk] = fileHunks("src/pay.rs", Array.from({ length: 12 }, (_, i) => `let x${i} = 1;`).join("\n"));
  const text = hunkContext(chunk!);
  expect(text).toContain("This is not a change");
  expect(text).toContain("a Rust file");
  expect(text).toContain("lines 1–12");
  expect(text).toContain("Every line is marked `+` because the whole file is being read");
  expect(text).not.toContain("added by this change");
  expect(text).not.toContain("previous behaviour");
});

test("a new file says there is no previous version, rather than inviting a before/after comparison", () => {
  const added = diff(`diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const a = 1;
+export const b = 2;
`);
  const text = hunkContext(added);
  expect(text).toContain("added by this change");
  expect(text).toContain("no previous behaviour to compare against");
});

test("the file's role is stated, so a rule need not enumerate every test path itself", () => {
  expect(hunkContext({ ...diff(MODIFIED), file: "app/__tests__/pay.test.ts" })).toContain("This is a test file");
  expect(hunkContext({ ...diff(MODIFIED), file: "docs/guide.md" })).toContain("This is documentation");
  expect(hunkContext({ ...diff(MODIFIED), file: "app/features/send/Send.tsx" })).not.toContain("test file");
});

test("the rest of the change is named but never sent, and a whole-file run claims no siblings", () => {
  const withSiblings = hunkContext(diff(MODIFIED), { siblings: ["app/features/send/Send.tsx", "wallet/src/pay.ts"] });
  expect(withSiblings).toContain("also touches `wallet/src/pay.ts`");
  expect(withSiblings).not.toContain("`app/features/send/Send.tsx`. Their");
  expect(withSiblings).toContain("Their contents are not shown.");

  const many = hunkContext(diff(MODIFIED), { siblings: Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`) });
  expect(many).toContain("and 10 more");

  const [chunk] = fileHunks("src/pay.ts", "export const a = 1;");
  expect(hunkContext(chunk!, { siblings: ["src/other.ts"] })).not.toContain("also touches");
});

test("every hunk carries the answering rules, stated once rather than per question", () => {
  for (const text of [hunkContext(diff(MODIFIED)), hunkContext(fileHunks("a.py", "x = 1")[0]!)]) {
    expect(text).toContain("How to answer:");
    expect(text).toContain("absent code is not evidence");
    expect(text).toContain("Anything not supplied remains unseen");
    expect(text).toContain("an unrelated hunk is a no, not a maybe");
  }
});

test("languages and roles are recognised by path, and unknown ones are not invented", () => {
  expect(languageOf("a/b.tsx")).toBe("TypeScript JSX");
  expect(languageOf("Dockerfile")).toBe("Dockerfile");
  expect(languageOf("a/b.weird")).toBeNull();
  expect(roleOf("src/__fixtures__/a.json")).toBe("fixture");
  expect(roleOf("examples/demo.ts")).toBe("example");
  expect(roleOf("src/api.generated.ts")).toBe("generated");
  expect(roleOf("tsconfig.json")).toBe("config");
  expect(roleOf("app/features/send/Send.tsx")).toBeNull();
});

test("the judging contract reaches the wire on every question kind, and a bare noul still fails safe", () => {
  const noul = toWire({ kind: "noul", instructions: "Does `hunk` log a secret?", threshold: 0.8 });
  expect(noul.instructions).toContain("Does `hunk` log a secret?");
  expect(noul.instructions).toContain("Read `context` first");
  expect(noul.instructions).toContain("Answer no if this hunk is unrelated");
  expect(noul.type === "noul" && noul.criteria?.false).toContain("not enough visible evidence");

  const choice = toWire({ kind: "choice", instructions: "Which layer?", criteria: { ui: "UI", data: "Data" }, report: ["ui"], abstain: [], minConfidence: 0 });
  expect(choice.instructions).toContain("Read `context` first");
  // "answer no" is meaningless for a choice, so the no-evidence clause stays off it.
  expect(choice.instructions).not.toContain("Answer no");

  const score = toWire({ kind: "score", instructions: "How risky?", criteria: ["low", "high"], reportAbove: 0.5, minConfidence: 0 });
  expect(score.instructions).toContain("Read `context` first");
  expect(score.instructions).not.toContain("Answer no");
});

test("a rule's own criteria are never rewritten by the engine", () => {
  const mine = { true: "exactly this", false: "exactly that" };
  const wire = toWire({ kind: "noul", instructions: "?", threshold: 0.8, criteria: mine });
  expect(wire.type === "noul" && wire.criteria).toEqual(mine);
});
