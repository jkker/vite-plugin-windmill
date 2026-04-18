import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    exclude: ["**/e2e/**", "**/*.spec.*", "**/node_modules/**"],
    include: ["tests/**/*.test.ts"],
  },
  pack: [
    {
      deps: {
        skipNodeModulesBundle: true,
      },
      dts: {
        tsgo: true,
      },
      sourcemap: true,
      entry: "src/index.ts",
      exports: {
        devExports: "source",
        legacy: true,
      },
    },
    {
      entry: "src/cli.ts",
    },
  ],
});
