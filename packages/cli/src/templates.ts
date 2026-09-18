export const TS_TEMPLATE = `import { defineConfig } from "@kelbie/hunch";

export default defineConfig({
  extends: ["hunch:recommended"],
  include: ["**/*.{ts,tsx,js,jsx}"],
  ignore: ["dist/**", "node_modules/**", "**/*.generated.ts"],
  rules: {
    "design/hide-implementation": ["warn", "Public functions should express the caller's task without requiring callers to coordinate internal bookkeeping."],
    "errors/preserve-failure": ["warn", "A failed operation must not be presented to the caller as a successful empty result."],
  },
});
`;
export const TOML_TEMPLATE = `# Hunch uses the same semantic review engine for every language.
extends = ["hunch:recommended"]
include = ["**/*.rs"]
ignore = ["target/**"]

[rules]
"design/hide-implementation" = ["warn", "Public functions should express the caller's task without requiring callers to coordinate internal bookkeeping."]
"errors/preserve-context" = ["warn", "Error conversions should preserve the cause needed for the caller to distinguish recovery from retry."]
`;
