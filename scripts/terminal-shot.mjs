#!/usr/bin/env node
/**
 * Renders captured terminal output as the PNG the README shows.
 *
 * Screenshots taken by hand drift: a different terminal theme, a different font, a window cropped
 * by eye. Every image under docs/images comes through here instead, from real ANSI output, so they
 * agree with each other and can be remade when the report changes.
 *
 *   FORCE_COLOR=1 npx @kelbie/hunch check --all … > /tmp/out.ansi
 *   node scripts/terminal-shot.mjs /tmp/out.ansi docs/images/check-all.png \
 *     --command 'npx @kelbie/hunch check --all …' --title 'hunch check'
 *
 * Needs Google Chrome; it drives it over the DevTools protocol and clips to the window element,
 * so the image needs no cropping afterwards.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SCALE = 2; // Retina, matching the images already in the README.

/** One palette for every screenshot, so two images never disagree about what "warn" looks like. */
const COLORS = { 31: "#ff6b6b", 32: "#79d17a", 33: "#e7c26a", 34: "#7aa2f7", 35: "#c58af9", 36: "#5fc9d4", 37: "#d6dae3" };
const ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escape = (s) => s.replace(/[&<>"]/g, (c) => ESCAPE[c]);

/** ANSI SGR to spans. Only the codes report.ts and find.ts emit: bold, dim and the eight colours. */
export function ansiToHtml(text) {
  const out = [];
  let open = 0;
  for (const part of text.split(/(\x1b\[\d+m)/)) {
    const code = /^\x1b\[(\d+)m$/.exec(part)?.[1];
    if (code === undefined) { out.push(escape(part)); continue; }
    if (code === "0") { out.push("</span>".repeat(open)); open = 0; }
    else if (code === "1") { out.push('<span class="b">'); open++; }
    else if (code === "2") { out.push('<span class="d">'); open++; }
    else if (COLORS[code]) { out.push(`<span style="color:${COLORS[code]}">`); open++; }
  }
  return out.join("") + "</span>".repeat(open);
}

/** Wraps a long command under a hanging indent, so one image is never wider than its own output. */
export function wrapCommand(command, width, indent = 2) {
  const lines = [];
  let line = "";
  for (const word of command.split(/\s+/).filter(Boolean)) {
    const max = lines.length ? width - indent : width;
    if (line && line.length + 1 + word.length > max) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i ? " ".repeat(indent) + l : l)).join("\n");
}

export function page({ body, command, title, cwd }) {
  // The output decides the image width; the command wraps to fit it rather than stretching it.
  const columns = Math.max(40, ...body.split("\n").map((l) => l.replace(/<[^>]+>/g, "").length));
  const wrapped = command ? wrapCommand(command, Math.max(40, columns - cwd.length - 3)) : "";
  const prompt = command
    ? `<span class="cmd"><span class="pr">${escape(cwd)}</span> <span class="pc">$</span> ${escape(wrapped)}</span>\n\n`
    : "";
  return `<!doctype html><meta charset="utf-8"><style>
  :root { color-scheme: dark }
  * { margin:0; padding:0; box-sizing:border-box }
  body { background:#0f1116; padding:40px; width:max-content }
  .win { background:#171a21; border-radius:10px; overflow:hidden; width:max-content }
  .bar { height:32px; background:#21242c; display:flex; align-items:center; padding:0 12px; gap:7px }
  .dot { width:11px; height:11px; border-radius:50% }
  .t { margin-left:10px; color:#7e8795; font:500 12px/1 -apple-system,system-ui,sans-serif }
  pre { padding:16px 18px 18px; color:#d6dae3; white-space:pre; -webkit-font-smoothing:antialiased;
        font:13px/1.55 ui-monospace,"SF Mono",Menlo,Consolas,monospace }
  .b { font-weight:700; color:#fff }
  .d { opacity:.52 }
  .pr { color:#5fc9d4 } .pc { color:#79d17a } .cmd { color:#e8ecf2 }
</style>
<div class="win">
  <div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="t">${escape(title)}</span></div>
  <pre>${prompt}${body}</pre>
</div>`;
}

async function capture(htmlPath, out) {
  const profile = mkdtempSync(join(tmpdir(), "hunch-shot-"));
  const chrome = spawn(CHROME, ["--headless", "--disable-gpu", "--hide-scrollbars", "--remote-debugging-port=0",
    `--user-data-dir=${profile}`, "--window-size=2400,3000", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("Chrome did not report a debugging endpoint")), 20_000);
      chrome.stderr.on("data", (d) => {
        buf += d;
        const m = /ws:\/\/\S+/.exec(buf);
        if (m) { clearTimeout(timer); resolve(m[0]); }
      });
      chrome.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Chrome exited (${code}). Is it installed? Set CHROME_PATH.`)); });
    });
    // The endpoint Chrome prints is the browser target, which has no Page domain; the page's own
    // socket comes from the HTTP list.
    const port = new URL(wsUrl).port;
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find((t) => t.type === "page");
    if (!target) throw new Error("Chrome opened no page target");
    const png = await screenshot(target.webSocketDebuggerUrl, htmlPath);
    writeFileSync(out, Buffer.from(png, "base64"));
  } finally {
    chrome.kill();
  }
}

/** Clips to the terminal window's own box, so the PNG is the content and nothing else. */
async function screenshot(wsUrl, htmlPath) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let id = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("Could not reach Chrome")); });
  let loaded;
  const onLoad = new Promise((resolve) => { loaded = resolve; });
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.method === "Page.loadEventFired") return loaded();
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  };
  try {
    await send("Page.enable");
    await send("Page.navigate", { url: `file://${htmlPath}` });
    await onLoad;
    const { result } = await send("Runtime.evaluate", {
      expression: `(() => { const r = document.querySelector('.win').getBoundingClientRect();
        return JSON.stringify({ x: 0, y: 0, width: r.right + r.left, height: r.bottom + r.top }); })()`,
    });
    const clip = { ...JSON.parse(result.value), scale: SCALE };
    const { data } = await send("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: true });
    return data;
  } finally {
    ws.close();
  }
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { command: { type: "string" }, title: { type: "string" }, cwd: { type: "string", default: "~" } },
});
const [input, out] = positionals;
if (!input || !out) {
  console.error("usage: terminal-shot.mjs <captured.ansi> <out.png> [--command '…'] [--title '…'] [--cwd '~/repo']");
  process.exit(2);
}
const html = join(mkdtempSync(join(tmpdir(), "hunch-shot-html-")), "shot.html");
writeFileSync(html, page({
  body: ansiToHtml(readFileSync(input, "utf8").replace(/\n+$/, "")),
  command: values.command ?? "",
  title: values.title ?? "hunch",
  cwd: values.cwd,
}));
await capture(html, out);
console.log(`wrote ${out}`);
