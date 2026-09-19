#!/usr/bin/env node
import { main } from "./program.js";

main().catch((e) => {
  // Provider SDK errors carry terminal colour codes; keep output plain and identical across runners.
  console.error(`hunch: ${String(e instanceof Error ? e.message : e).replace(/\x1b\[[0-9;]*m/g, "").trimEnd()}`);
  process.exitCode = 2;
});
