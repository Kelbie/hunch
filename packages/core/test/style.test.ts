import { expect, test } from "bun:test";
import { clip, clipLeft, pad, painter, visibleWidth, wrapText } from "../src/style.js";

const p = painter(true);

test("colour is opt-in, and asking for none gives back the string untouched", () => {
  const plain = painter(false);
  expect(plain.red("error")).toBe("error");
  expect(p.red("error")).toBe("\x1b[31merror\x1b[0m");
});

test("width and padding count what is on screen, not the escapes that put it there", () => {
  expect(visibleWidth(p.red("error"))).toBe(5);
  expect(visibleWidth("error")).toBe(5);
  // A coloured cell and a plain one of the same text end in the same column.
  expect(visibleWidth(pad(p.red("error"), 10))).toBe(10);
  expect(pad("error", 10)).toBe(pad("error", 10));
  expect(pad(p.red("error"), 10)).toBe(`${p.red("error")}     `);
});

test("a clipped line closes the colour it cut, so it cannot repaint the rest of the terminal", () => {
  const line = `${p.red("[ERROR]")} ${p.cyan("payments/retry-safety")}`;
  const cut = clip(line, 12);
  expect(visibleWidth(cut)).toBe(12);
  expect(cut.endsWith("\x1b[0m")).toBe(true);
  // Nothing is touched when it already fits.
  expect(clip(line, 100)).toBe(line);
  expect(clip("plain text", 4)).toBe("plai");
});

test("a path clipped from the left keeps its end, and a short one is left alone", () => {
  expect(clipLeft("packages/core/src/report.ts", 14)).toBe("…src/report.ts");
  expect(clipLeft("a.ts", 14)).toBe("a.ts");
  expect(clipLeft("packages/core/src/report.ts", 14).length).toBeLessThanOrEqual(14);
});

test("prose wraps at the indent and never hyphenates or drops a word", () => {
  const text = "Retrying after a timeout may charge the customer twice, because the key is new.";
  const wrapped = wrapText(text, 4, 44);
  for (const line of wrapped.split("\n")) {
    expect(line.startsWith("    ")).toBe(true);
    expect(line.length).toBeLessThanOrEqual(44);
  }
  expect(wrapped.replace(/\s+/g, " ").trim()).toBe(text);
});
