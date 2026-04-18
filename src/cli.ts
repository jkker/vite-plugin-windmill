#!/usr/bin/env node

import { parseArgs } from "node:util";

import { deploy } from "./deploy.ts";

export const main = async () => {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      css: { type: "string" },
      dir: { type: "string" },
      dry: { type: "boolean" },
      entry: { type: "string" },
      js: { type: "string" },
      message: { type: "string" },
      path: { type: "string" },
      root: { type: "string" },
      token: { type: "string" },
      url: { type: "string" },
      workspace: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    return console.log(
      `
Usage: vite-plugin-windmill [options]

Deploy a built Windmill raw app bundle.

Options:
  -h, --help          Show this help message
  --base <path>       Override the raw-app base path
  --css <path>        Path to the CSS file to include in the deployment
  --dir <path>        Raw-app directory to resolve and deploy from
  --dry               Perform a dry run without making any changes
  --entry <path>      Override the raw-app entry file
  --js <path>         Path to the JavaScript file to include in the deployment
  --message <text>    Deployment message or description
  --path <path>       Override the inferred Windmill raw-app path
  --root <path>       Override the workspace root used to infer the app path
  --token <token>     Windmill API token for authentication
  --url <url>         Windmill instance URL
  --workspace <name>  Windmill workspace name

Connection resolution order:
  workspace: --workspace, WM_WORKSPACE
  token:     --token, WM_TOKEN
  url:       --url, BASE_INTERNAL_URL, BASE_URL
     `.trim(),
    );
  }

  const result = await deploy(values);

  console.log(JSON.stringify(result, null, 2));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
