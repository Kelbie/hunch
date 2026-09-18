import { expect, test } from "bun:test";
import { applyPresets, evaluateConfigSource, parseConfig, rulesFor, tomlToConfig } from "../../core/src/index.js";
import { GENERAL_TEMPLATE, TOML_TEMPLATE, TS_TEMPLATE } from "../src/templates.js";

test("init templates are valid configs", () => {
  const ts = applyPresets(parseConfig(evaluateConfigSource(TS_TEMPLATE), "hunch.config.ts"));
  const general = applyPresets(parseConfig(tomlToConfig(GENERAL_TEMPLATE), "hunch.toml"));
  expect(rulesFor("src/app.py", general).jev.map(r => r.id)).toContain("failures/misleading-success");
  const toml = applyPresets(parseConfig(tomlToConfig(TOML_TEMPLATE), "hunch.toml"));
  expect(rulesFor("src/app.ts", ts).jev.map(r => r.id)).toContain("typescript/async-ordering");
  expect(toml.rules["rust/error-context"]!.question).toMatchObject({ kind: "noul" });
  expect(rulesFor("tests/it.rs", toml).jev.map((r) => r.id)).toContain("failures/misleading-success");
  expect(rulesFor("src/lib.rs", toml).jev.map((r) => r.id)).toContain("failures/misleading-success");
});
