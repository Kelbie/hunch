#!/usr/bin/env node
/**
 * Colours a TypeScript or TOML file with the eight ANSI codes terminal-shot.mjs understands,
 * so a config example in the docs is painted from the same palette as a captured report.
 *
 *   node scripts/code-ansi.mjs hunch.config.ts > /tmp/config.ansi
 *   node scripts/terminal-shot.mjs /tmp/config.ansi docs/demo/hunch-config.png \
 *     --command 'cat hunch.config.ts' --title 'hunch config' --cwd '~/sovran-app'
 *
 * The file's text is real — it is read from disk, and the one in docs/demo is a config that
 * `hunch config` accepts and `hunch install` resolves. Only the colouring is authored here:
 * a highlighter that emits 24-bit colour (bat, pygments) would be dropped by terminal-shot,
 * which reads the base eight on purpose so every image agrees about what a colour means.
 *
 * It is a lexer, not a parser: enough to tell a comment from a string from a keyword in a
 * short configuration file. Do not point it at a program.
 *
 * Its companion needs no lexer, because `hunch config` already paints its own output. In a
 * scratch repository holding docs/demo/hunch.config.ts, after `hunch install`:
 *
 *   FORCE_COLOR=1 hunch config > /tmp/resolved.ansi
 *   node scripts/terminal-shot.mjs /tmp/resolved.ansi docs/demo/hunch-config-rules.png \
 *     --command 'hunch config' --title 'hunch config' --cwd '~/sovran-app' 
 */
import { readFileSync } from "node:fs";

const M = "\x1b[35m", G = "\x1b[32m", C = "\x1b[36m", D = "\x1b[2m", R = "\x1b[0m";
const KEYWORDS = new Set(["import", "from", "export", "default", "const", "as", "satisfies", "true", "false"]);

/** One line at a time: a comment runs to the end of it, and a string never spans one here. */
export function colorLine(line) {
  let out = "";
  for (let i = 0; i < line.length; ) {
    const rest = line.slice(i);
    const comment = /^(\/\/.*|#.*)$/.exec(rest);
    if (comment) { out += D + comment[0] + R; break; }
    const string = /^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/.exec(rest);
    if (string) { out += G + string[0] + R; i += string[0].length; continue; }
    const word = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (word) {
      // A key or a call gets the colour the reports give an identifier; a keyword gets its own.
      // Key wins: `true:` and `false:` are criteria names here, not the literals they look like.
      const after = line.slice(i + word[0].length);
      const paint = /^\s*[:(]/.test(after) ? C : KEYWORDS.has(word[0]) ? M : "";
      out += paint ? paint + word[0] + R : word[0];
      i += word[0].length;
      continue;
    }
    out += line[i];
    i += 1;
  }
  return out;
}

const file = process.argv[2];
if (!file) { console.error("usage: code-ansi.mjs <file.ts|file.toml>"); process.exit(2); }
process.stdout.write(readFileSync(file, "utf8").replace(/\s+$/, "").split("\n").map(colorLine).join("\n") + "\n");
