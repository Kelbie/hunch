import { defineConfig } from "tsup";
export default defineConfig({
  entry: { bin: "src/bin.ts", index: "src/index.ts" },
  format: ["esm"], target: "node22", clean: true, splitting: false,
  noExternal: ["@kelbie/hunch-core"],
  dts: { entry: "src/index.ts", resolve: ["@kelbie/hunch-core"] },
});
