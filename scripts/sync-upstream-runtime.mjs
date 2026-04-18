import {
  getOptionValue,
  resolveWindmillVersion,
  writeGeneratedRuntimeFile,
} from "./release-utils.mjs";

const requestedVersion = getOptionValue(process.argv.slice(2), "--version");
const windmillVersion = await resolveWindmillVersion(requestedVersion);
const result = await writeGeneratedRuntimeFile({ windmillVersion });

console.log(
  `Updated ${result.relativeOutputPath} from Windmill ${windmillVersion} (${result.sourceUrl})`,
);
