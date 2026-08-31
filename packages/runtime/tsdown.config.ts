import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node22.19",
  dts: true,
  clean: true,
  minify: false,
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
});
