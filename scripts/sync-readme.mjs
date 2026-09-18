#!/usr/bin/env node
/**
 * The npm package shows its own README, which had drifted into a second, older description of the
 * same tool. It is generated from the repository's README instead, with relative links made
 * absolute so images and docs resolve on npmjs.com. Run by the CLI's build, so it cannot go stale.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = "https://raw.githubusercontent.com/Kelbie/hunch/main/";
const BLOB = "https://github.com/Kelbie/hunch/blob/main/";

export function absolutise(markdown) {
  return markdown
    .replace(/!\[([^\]]*)\]\((?!https?:)([^)]+)\)/g, (_, alt, path) => `![${alt}](${RAW}${path})`)
    .replace(/\[([^\]]+)\]\((?!https?:|#)([^)]+)\)/g, (_, text, path) => `[${text}](${BLOB}${path})`);
}

const source = readFileSync(join(root, "README.md"), "utf8");
const out = join(root, "packages/cli/README.md");
writeFileSync(out, absolutise(source));
console.log(`synced ${out} from README.md`);
