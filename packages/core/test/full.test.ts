import { describe, expect, test } from "bun:test";
import { check } from "../src/check.js";
import { fileHunks, inScope, repoHunks, underPaths } from "../src/full.js";
import { parseConfig } from "../src/schema.js";
import { fakeJev, memoryRepo } from "./helpers.js";

const fn = (name: string, body: number) => [`export function ${name}() {`, ...Array.from({ length: body }, (_, i) => `  step(${i});`), "}", ""];

describe("whole-file review", () => {
  test("a short file is one chunk of added lines numbered from 1", () => {
    const [h, ...rest] = fileHunks("a.ts", "import x from 'x';\n\nexport const y = x;\n");
    expect(rest).toEqual([]);
    expect(h!.status).toBe("added");
    expect(h!.added.map((a) => a.line)).toEqual([1, 2, 3]);
    expect(h!.text.split("\n").slice(1)).toEqual(["+import x from 'x';", "+", "+export const y = x;"]);
  });

  test("long files split at top-level declarations and later chunks repeat the imports as context", () => {
    const lines = ["import { step } from './step';", "", ...fn("one", 60), ...fn("two", 60), ...fn("three", 60)].slice(0, -1);
    const hunks = fileHunks("big.ts", lines.join("\n"), 150);
    expect(hunks.length).toBe(2);
    // The cut lands on `export function three`, never inside a function body.
    expect(hunks[1]!.added[0]!.content).toBe("export function three() {");
    expect(hunks[1]!.added[0]!.line).toBe(lines.indexOf("export function three() {") + 1);
    const body = hunks[1]!.text.split("\n").slice(1);
    expect(body[0]).toBe(" import { step } from './step';");
    expect(body.filter((l) => l.startsWith("+")).length).toBe(hunks[1]!.added.length);
    // Every line of the file is reviewed exactly once.
    expect(hunks.flatMap((h) => h.added.map((a) => a.line))).toEqual(lines.map((_, i) => i + 1));
  });

  test("a file without boundaries is still split at the line limit", () => {
    const hunks = fileHunks("flat.ts", Array.from({ length: 320 }, (_, i) => `  x${i};`).join("\n"), 150);
    expect(hunks.map((h) => h.added.length)).toEqual([150, 150, 20]);
  });

  test("lockfiles and generated files are never in scope; config ignore still applies", () => {
    const reviewed = inScope(parseConfig({ ignore: ["gen/**"] }, "t"));
    for (const f of ["package-lock.json", "web/yarn.lock", "bun.lock", "Cargo.lock", "go.sum", "dist/app.min.js", "a.js.map", "node_modules/x/i.js", "gen/types.ts"]) expect(reviewed(f)).toBe(false);
    for (const f of ["src/index.ts", "Cargo.toml", "package.json"]) expect(reviewed(f)).toBe(true);
  });

  test("path filters match files and folders, not name prefixes", () => {
    const under = underPaths(["./app/features/send/", "README.md"]);
    expect(["app/features/send/a.ts", "README.md"].every(under)).toBe(true);
    expect(["app/features/sender/a.ts", "app/features/a.ts"].some(under)).toBe(false);
    expect(underPaths([])("anything")).toBe(true);
  });

  test("repoHunks reviews in-scope text files under the requested paths and reports binaries", async () => {
    const repo = memoryRepo({ "src/a.ts": "export const a = 1;\n", "src/b.png": "\0PNG", "docs/c.md": "# c\n", "yarn.lock": "x" });
    const { hunks, skipped } = await repoHunks(repo, parseConfig({}, "t"), ["src"]);
    expect(hunks.map((h) => h.file)).toEqual(["src/a.ts"]);
    expect(skipped).toEqual(["src/b.png"]);
  });

  test("findings point at the chunk, and request budgets make the review explicitly partial", async () => {
    const { client, calls } = fakeJev(() => ({ type: "noul", p: 0.95 }));
    const hunks = [...fileHunks("a.ts", "const a = 1;\n"), ...fileHunks("b.ts", "const b = 2;\n")];
    const config = parseConfig({ rules: { r: ["warn", "Rule."] }, budget: { maxRequests: 1 } }, "t");
    const result = await check({ config, hunks, client });
    expect(calls.length).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ line: 1, endLine: 1 });
    expect(result.complete).toBe(false);
  });
});
