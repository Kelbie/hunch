/**
 * The SemIf bridge is a Python file, so no bundler carries it: `dist/bin.js` looks for it beside
 * itself, and `npm pack` only ships `dist`. Copied after tsup, which clears that directory.
 */
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const to = join(root, "packages/cli/dist/semif");
mkdirSync(to, { recursive: true });
cpSync(join(root, "packages/core/semif"), to, { recursive: true });
console.log(`copied the SemIf bridge into ${to.replace(`${root}/`, "")}`);
