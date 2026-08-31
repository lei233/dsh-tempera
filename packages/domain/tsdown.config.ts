import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: "esm",
  platform: "neutral",
  target: "es2022",
  dts: true,
  clean: true,
  minify: false,
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
});
