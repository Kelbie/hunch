import { clip, painter, visibleWidth } from "../../core/src/index.js";

/**
 * The bottom rows of a terminal, redrawn in place while a long command waits.
 *
 * A repository sweep or a whole-file review runs for minutes, and a person watching it needs two
 * things a final report cannot give them: what has been found so far, and how much longer this
 * will take. Both belong at the bottom of the screen, above the shell prompt, and both are gone
 * the moment the real report is printed — nothing drawn here survives, so nothing drawn here can
 * be mistaken for the result.
 *
 * It draws on stderr, so a report redirected to a file or a pipe never contains a progress bar,
 * and it draws nothing at all when stderr is not a terminal: `\r` and cursor moves in a CI log
 * are noise. `log` exists for the lines that must survive — a provider failure, an interruption —
 * and prints them above the region, where scrollback keeps them.
 */
export interface Live {
  /** Redraw now, rather than waiting for the next tick. */
  refresh(): void;
  /** A line that outlives the run: printed above the region, kept by scrollback. */
  log(line: string): void;
  /** Erase the region for good. Safe to call twice; the cursor comes back either way. */
  stop(): void;
}

export interface LiveOptions {
  /** Lines drawn per second. The spinner and the estimate move on their own between events. */
  fps?: number;
  /** Test seam: the clock the timer and the estimate read. */
  now?: () => number;
}

const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
/** Erase from the cursor to the end of the screen: the whole region in one write. */
const ERASE = "\x1b[0J";

/** A region that draws nothing, for a pipe, a CI log or a `--dry-run`. `log` still reaches stderr. */
export function silentRegion(stream: NodeJS.WritableStream): Live {
  return { refresh() {}, log: (line) => void stream.write(`${line}\n`), stop() {} };
}

/**
 * Pins `frame(width)` to the bottom of `stream` until `stop()`. The frame is recomputed on every
 * draw, so a caller keeps its counters in ordinary variables and never formats anything twice, and
 * it is handed the width it must fit rather than guessing: a row laid out for one more column than
 * the region will draw loses the end of its evidence.
 */
export function liveRegion(stream: NodeJS.WriteStream, frame: (width: number) => string[], { fps = 10, now = Date.now }: LiveOptions = {}): Live {
  if (!stream.isTTY) return silentRegion(stream);
  let drawn = 0;
  let stopped = false;
  let last = 0;

  const erase = () => {
    if (!drawn) return;
    stream.write(`\r${drawn > 1 ? `\x1b[${drawn - 1}A` : ""}${ERASE}`);
    drawn = 0;
  };
  const draw = () => {
    if (stopped) return;
    // Two rows are left for the shell: a region as tall as the window scrolls its own top away.
    const height = Math.max(1, (stream.rows || 24) - 2);
    const width = Math.max(20, (stream.columns || 80) - 1);
    // A row may be two lines when a narrow terminal pushes the evidence under it.
    const lines = frame(width).flatMap((l) => l.split("\n")).slice(-height).map((l) => clip(l, width));
    erase();
    if (lines.length) stream.write(lines.join("\n"));
    drawn = lines.length;
    last = now();
  };

  stream.write(HIDE);
  // An unref'd timer never keeps the process alive: a finished search exits on its own.
  const timer = setInterval(draw, Math.max(1, Math.round(1000 / fps)));
  timer.unref?.();
  // A crash or a second Ctrl-C must not leave the terminal without a cursor.
  const restore = () => { if (!stopped) stream.write(SHOW); };
  process.once("exit", restore);
  draw();

  return {
    refresh() {
      // Events arrive in bursts; the timer keeps the estimate moving between them.
      if (now() - last >= 1000 / fps) draw();
    },
    log(line) {
      erase();
      stream.write(`${line}\n`);
      draw();
    },
    stop() {
      if (stopped) return;
      clearInterval(timer);
      erase();
      stream.write(SHOW);
      stopped = true;
      process.off("exit", restore);
    },
  };
}

/** Braille where the terminal can show it, ASCII where it cannot. */
const UNICODE = /utf-?8/i.test(process.env.LC_ALL ?? process.env.LC_CTYPE ?? process.env.LANG ?? "") && process.env.TERM !== "dumb";
const SPINNER = UNICODE ? [..."⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"] : [..."|/-\\"];
const FILLED = UNICODE ? "█" : "#";
const EMPTY = UNICODE ? "░" : "·";

/** The spinner frame for a moment in time, so it turns at the same rate whatever is happening. */
export const spinner = (elapsedMs: number) => SPINNER[Math.floor(elapsedMs / 80) % SPINNER.length]!;

/** A bar of `width` cells. An unknown total leaves it empty rather than guessing a fraction. */
export function bar(done: number, total: number, width: number): string {
  const filled = total > 0 ? Math.min(width, Math.round((done / total) * width)) : 0;
  return FILLED.repeat(filled) + EMPTY.repeat(Math.max(0, width - filled));
}

/**
 * How much longer, from the rate so far. Nothing is claimed before enough has finished for the
 * rate to mean anything: an estimate off by a factor of ten is worse than no estimate.
 */
export function remaining(elapsedMs: number, done: number, total: number): number | null {
  if (done < 3 || done >= total || elapsedMs <= 0) return null;
  return Math.round((elapsedMs / done) * (total - done));
}

/** A duration a person reads at a glance: `8s`, `1m 20s`, `2h 5m`. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/**
 * The status line every long command ends its region with: what it is working through, how far in,
 * and how long is left. `extra` is the command's own tally — findings so far, passages so far.
 */
export function statusLine(
  { label, done, total, elapsedMs, extra = "", color = false, width = 100 }:
  { label: string; done: number; total: number; elapsedMs: number; extra?: string; color?: boolean; width?: number },
): string {
  const { bold, cyan, dim } = painter(color);
  const left = remaining(elapsedMs, done, total);
  const percent = total > 0 ? Math.floor((done / total) * 100) : 0;
  const head = `  ${cyan(spinner(elapsedMs))} ${bold(`${done}/${total}`)} ${label}`;
  const tail = `${percent.toString().padStart(3)}%  ${dim(left === null ? `${duration(elapsedMs)} elapsed` : `~${duration(left)} left`)}${extra ? `  ${dim("·")}  ${extra}` : ""}`;
  // The bar takes whatever the two ends leave it, and disappears rather than wrap the line.
  const room = width - visibleWidth(head) - visibleWidth(tail) - 4;
  return room >= 8 ? `${head}  ${dim(bar(done, total, Math.min(28, room)))}  ${tail}` : `${head}  ${tail}`;
}
