import { defineConfig } from "@kelbie/hunch";

export default defineConfig({
  extends: ["hunch:recommended"],
  include: ["**/*.{ts,tsx,js,jsx}"],
  ignore: ["dist/**", "node_modules/**", "**/*.generated.ts"],
  rules: {
    "design/hide-implementation": ["warn", "Public functions should express the caller's task without requiring callers to coordinate internal bookkeeping."],
    "errors/preserve-failure": ["warn", "A failed operation must not be presented to the caller as a successful empty result."],
  },
});
