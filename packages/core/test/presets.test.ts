import { expect, test } from "bun:test";
import { applyPresets, parseConfig, rulesFor } from "../src/index.js";

// Exercise the existing config -> effective file rules interface.
test("mixed-language repositories keep language presets scoped and accept user overrides", () => {
  const config = applyPresets(parseConfig({
    extends: ["hunch:recommended", "hunch:typescript", "hunch:rust"],
    rules: { "typescript/async-ordering": "error", "rust/error-context": "off" },
    overrides: [{ files: ["tests/**"], rules: { "rust/panic-on-recoverable-input": "off" } }],
  }, "test"));
  const ts = rulesFor("src/client.ts", config).jev;
  expect(ts.find(r => r.id === "typescript/async-ordering")?.level).toBe("error");
  expect(ts.some(r => r.id.startsWith("rust/"))).toBe(false);
  const rust = rulesFor("src/lib.rs", config).jev.map(r => r.id);
  expect(rust).toContain("rust/panic-on-recoverable-input");
  expect(rust).not.toContain("rust/error-context");
  expect(rust.some(id => id.startsWith("typescript/"))).toBe(false);
  expect(rulesFor("tests/recovery.rs", config).jev.some(r => r.id.startsWith("rust/"))).toBe(false);
  const python = rulesFor("src/service.py", config).jev.map(r => r.id);
  expect(python).toContain("failures/misleading-success");
  expect(python.some(id => /^(typescript|rust)\//.test(id))).toBe(false);
});
