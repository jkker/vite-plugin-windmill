import { getOptionValue, prepareRelease } from "./release-utils.mjs";

const requestedVersion = getOptionValue(process.argv.slice(2), "--version");
const result = await prepareRelease({ requestedVersion });

console.log(JSON.stringify(result, null, 2));
