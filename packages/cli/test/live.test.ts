import { expect, test } from "bun:test";
import { bar, duration, liveRegion, remaining, statusLine } from "../src/live.js";

/** A terminal that records what was written to it, so the cursor moves can be read back. */
function fakeTTY({ rows = 24, columns = 80, isTTY = true } = {}) {
  const writes: string[] = [];
  const stream = { isTTY, rows, columns, write: (s: string) => { writes.push(s); return true; } };
  return { stream: stream as unknown as NodeJS.WriteStream, writes, text: () => writes.join("") };
}

/** What the region left on screen: the last frame, with the escape codes gone. */
const screen = (text: string) => text.split(/\x1b\[\d*[A-Za-z]|\x1b\[\?25[lh]/).at(-1)!;

test("a redirected stream gets no cursor moves, because a progress bar in a log file is noise", () => {
  const { stream, text } = fakeTTY({ isTTY: false });
  const region = liveRegion(stream, () => ["  searching", "  1/9"]);
  region.refresh();
  region.stop();
  expect(text()).toBe("");
  // A line that must survive still reaches the stream: only the drawing is suppressed.
  region.log("hunch: a provider request failed");
  expect(text()).toBe("hunch: a provider request failed\n");
});

test("each frame erases the one before it, so the region stays put instead of scrolling", () => {
  const { stream, writes } = fakeTTY();
  let frame = ["  [EDIT]  a.ts:1-9  edit=0.90", "  1/9 chunks"];
  let clock = 0;
  const region = liveRegion(stream, () => frame, { fps: 10, now: () => clock });
  expect(writes.join("")).toContain("[EDIT]  a.ts:1-9");
  frame = ["  [EDIT]  a.ts:1-9  edit=0.90", "  [TEST]  b.test.ts:1-4  test=0.80", "  2/9 chunks"];
  clock += 500;
  region.refresh();
  // Two lines were drawn, so the cursor goes up one and everything below it is erased.
  expect(writes.join("")).toContain("\x1b[1A\x1b[0J");
  expect(screen(writes.join(""))).toContain("b.test.ts:1-4");
  region.stop();
  // Nothing the region drew survives it: the report below is the only version anyone keeps.
  expect(writes.at(-2)).toContain("\x1b[0J");
  expect(writes.at(-1)).toBe("\x1b[?25h");
});

test("the region never grows past the window, and clips a line rather than wrapping it", () => {
  const { stream, writes } = fakeTTY({ rows: 6, columns: 40 });
  const region = liveRegion(stream, (width) => [...Array.from({ length: 20 }, (_, i) => `row ${i}`), `  ${"x".repeat(width + 60)}`], { fps: 1000 });
  const drawn = screen(writes.join("")).split("\n");
  // Two rows are left for the shell, and the newest rows are the ones kept.
  expect(drawn).toHaveLength(4);
  expect(drawn[0]).toBe("row 17");
  for (const line of drawn) expect(line.length).toBeLessThanOrEqual(39);
  region.stop();
});

test("a line that must outlive the run is printed above the region, which is then redrawn", () => {
  const { stream, writes } = fakeTTY();
  const region = liveRegion(stream, () => ["  1/9 chunks"], { fps: 1000 });
  region.log("hunch: a provider request failed");
  const after = writes.join("");
  expect(after).toContain("hunch: a provider request failed\n");
  // The status line is back under it, so the run carries on looking like it is running.
  expect(screen(after)).toContain("1/9 chunks");
  region.stop();
});

test("stopping twice is safe, and gives the cursor back exactly once", () => {
  const { stream, writes } = fakeTTY();
  const region = liveRegion(stream, () => ["  1/9"], { fps: 1000 });
  region.stop();
  region.stop();
  expect(writes.filter((w) => w === "\x1b[?25h")).toHaveLength(1);
});

test("no estimate is offered until the rate means something, because a wrong one is worse than none", () => {
  expect(remaining(1000, 0, 100)).toBeNull();
  expect(remaining(1000, 2, 100)).toBeNull();
  expect(remaining(10_000, 10, 100)).toBe(90_000);
  // Finished is finished: there is nothing left to estimate.
  expect(remaining(10_000, 100, 100)).toBeNull();
});

test("durations read the way someone waiting would say them", () => {
  expect(duration(8_400)).toBe("8s");
  expect(duration(80_000)).toBe("1m 20s");
  expect(duration(120_000)).toBe("2m");
  expect(duration(7_500_000)).toBe("2h 5m");
});

test("the bar fills with progress and an unknown total leaves it empty rather than guessing", () => {
  const full = bar(1, 1, 1), none = bar(0, 1, 1);
  expect(full).not.toBe(none);
  expect(bar(5, 10, 10)).toBe(full.repeat(5) + none.repeat(5));
  expect(bar(0, 10, 4)).toBe(none.repeat(4));
  // A total of zero is not "finished": nothing is claimed about a length nobody knows.
  expect(bar(3, 0, 6)).toBe(none.repeat(6));
});

test("the status line says where it is and how long is left, and fits the terminal", () => {
  const line = statusLine({ label: "chunks searched", done: 212, total: 389, elapsedMs: 96_000, extra: "18 candidates so far", width: 100 });
  expect(line).toContain("212/389 chunks searched");
  expect(line).toContain("54%");
  expect(line).toContain("~1m 20s left");
  expect(line).toContain("18 candidates so far");
  expect(line.length).toBeLessThanOrEqual(100);
  // Too narrow for a bar, and the ends still both fit: the bar is what gives way.
  const narrow = statusLine({ label: "hunks checked", done: 2, total: 9, elapsedMs: 4_000, width: 46 });
  expect(narrow).toContain("2/9 hunks checked");
  expect(narrow.length).toBeLessThanOrEqual(46);
});

test("an early status line says how long it has been running rather than inventing a finish time", () => {
  expect(statusLine({ label: "hunks checked", done: 1, total: 400, elapsedMs: 3_000, width: 100 })).toContain("3s elapsed");
});

test("the width a frame is given is the width it is drawn at, so a row is never cut", () => {
  const { stream, writes } = fakeTTY({ columns: 64 });
  let given = 0;
  const region = liveRegion(stream, (width) => { given = width; return [`  ${"x".repeat(width)}`]; }, { fps: 1000 });
  const drawn = screen(writes.join("")).split("\n").at(-1)!;
  expect(drawn.length).toBe(given);
  expect(drawn).not.toContain("\n");
  region.stop();
});
