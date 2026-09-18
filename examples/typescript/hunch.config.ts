import { defineConfig } from "@kelbie/hunch";

export default defineConfig({
  extends: ["hunch:recommended", "hunch:typescript"],
  include: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
  ignore: ["dist/**", "node_modules/**", "**/*.generated.ts"],
});
