import { appendFile } from "node:fs/promises";

import { getOptionValue, getReleaseStatus } from "./release-utils.mjs";

const argv = process.argv.slice(2);
const requestedVersion = getOptionValue(argv, "--version");
const writeGitHubOutput = argv.includes("--github-output");

const status = await getReleaseStatus({ requestedVersion });
const result = {
  ...status,
  reason: status.shouldRelease
    ? `${status.releaseVersion} is not published to npm`
    : `${status.releaseVersion} is already published to npm`,
};

if (writeGitHubOutput) {
  if (!process.env.GITHUB_OUTPUT) {
    throw new Error("--github-output requires the GITHUB_OUTPUT environment variable");
  }

  const outputLines = Object.entries(result).map(([key, value]) => `${key}=${String(value)}`);
  await appendFile(process.env.GITHUB_OUTPUT, outputLines.join("\n") + "\n");
}

console.log(JSON.stringify(result, null, 2));
