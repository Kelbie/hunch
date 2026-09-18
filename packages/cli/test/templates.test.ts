import { expect, test } from "bun:test";
import { applyPresets, evaluateConfigSource, parseConfig, rulesFor, tomlToConfig } from "@kelbie/hunch-core";
import { TOML_TEMPLATE, TS_TEMPLATE } from "../src/templates.js";

test("init templates are valid configs", () => {
  const ts = applyPresets(parseConfig(evaluateConfigSource(TS_TEMPLATE), "hunch.config.ts"));
  const toml = applyPresets(parseConfig(tomlToConfig(TOML_TEMPLATE), "hunch.toml"));
  expect(Object.keys(ts.rules)).toContain("design/hide-implementation");
  expect(toml.rules["errors/preserve-context"]!.question).toMatchObject({ kind: "noul" });
  expect(rulesFor("tests/it.rs", toml).jev.map((r) => r.id)).toContain("design/hide-implementation");
  expect(rulesFor("src/lib.rs", toml).jev.map((r) => r.id)).toContain("design/hide-implementation");
});
