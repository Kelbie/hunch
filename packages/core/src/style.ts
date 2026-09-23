/**
 * The terminal vocabulary every report shares: one painter, one way to measure a coloured
 * string, one way to wrap prose. `check`, `find` and the live progress a run prints while it
 * waits all draw with these, so two Hunch reports never disagree about what a warning looks
 * like or where a column starts.
 *
 * Only bold, dim and the eight ANSI colours are used: `scripts/terminal-shot.mjs` renders the
 * documentation images from this same output, and it knows those codes alone.
 */

export interface Painter {
  bold: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  blue: (s: string) => string;
  magenta: (s: string) => string;
  cyan: (s: string) => string;
  plain: (s: string) => string;
}

/** `painter(false)` returns the identity for every colour, so callers never branch on colour. */
export function painter(color: boolean): Painter {
  const paint = (codes: string) => (s: string) => (color ? `\x1b[${codes}m${s}\x1b[0m` : s);
  return {
    bold: paint("1"), dim: paint("2"), red: paint("31"), green: paint("32"),
    yellow: paint("33"), blue: paint("34"), magenta: paint("35"), cyan: paint("36"),
    plain: (s: string) => s,
  };
}

const CODE = /^\x1b\[[0-9;]*m$/;
const SPLIT = /(\x1b\[[0-9;]*m)/;

/** Columns a string occupies once the escape codes are gone: what padding and clipping must count. */
export const visibleWidth = (s: string) => s.split(SPLIT).filter((p) => !CODE.test(p)).join("").length;

/** Pad to `width` counting visible characters, so a coloured cell lines up with an uncoloured one. */
export function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visibleWidth(s)));
}

/**
 * Clip to `width` visible columns, keeping every escape code and closing one still open at the
 * cut. A clipped line that left a colour open would repaint the rest of the terminal.
 */
export function clip(s: string, width: number): string {
  if (visibleWidth(s) <= width) return s;
  let out = "";
  let shown = 0;
  let open = false;
  for (const part of s.split(SPLIT)) {
    if (CODE.test(part)) { out += part; open = part !== "\x1b[0m"; continue; }
    if (shown >= width) continue;
    out += part.slice(0, width - shown);
    shown = Math.min(width, shown + part.length);
  }
  return open ? `${out}\x1b[0m` : out;
}
/** A path too long for its column keeps its tail: the file name is what tells two rows apart. */
export const clipLeft = (text: string, width: number) => (text.length <= width ? text : `…${text.slice(1 - width)}`);

/** Word wrap at an indent. Code is never wrapped; prose always is. */
export function wrapText(text: string, indent: number, width = 100): string {
  const max = Math.max(40, width - indent);
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > max) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.map((l) => " ".repeat(indent) + l).join("\n");
}

/** `0.93` as a fixed two-decimal cell, so a column of scores reads as a column. */
export const score2 = (n: number) => n.toFixed(2);
