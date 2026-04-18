import { readFile, writeFile } from "node:fs/promises";

import { packageJsonPath } from "./release-utils.mjs";

const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));

packageJson.bin = {
  "vite-plugin-windmill": "bin/vite-plugin-windmill",
};
packageJson.exports = {
  ".": "./dist/index.mjs",
  "./package.json": "./package.json",
};
packageJson.publishConfig ??= {};
packageJson.publishConfig.access = "public";
packageJson.publishConfig.provenance = true;
delete packageJson.publishConfig.exports;

await writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n");
