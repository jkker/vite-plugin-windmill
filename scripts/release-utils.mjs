import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

export const PLUGIN_PACKAGE_NAME = "vite-plugin-windmill";
export const WINDMILL_CLIENT_PACKAGE_NAME = "windmill-client";
export const WINDMILL_REPOSITORY = "windmill-labs/windmill";
export const RAW_RUNTIME_PATH = "frontend/src/lib/rawAppWmillTs.ts";
export const COMPATIBILITY_BLOCK_START = "<!-- windmill-release:compat-start -->";
export const COMPATIBILITY_BLOCK_END = "<!-- windmill-release:compat-end -->";

const REGISTRY_BASE_URL = "https://registry.npmjs.org";
const USER_AGENT = "vite-plugin-windmill-release";

const currentFile = fileURLToPath(import.meta.url);
export const packageRoot = path.resolve(path.dirname(currentFile), "..");
export const packageJsonPath = path.join(packageRoot, "package.json");
export const readmePath = path.join(packageRoot, "README.md");
export const generatedRuntimePath = path.join(
  packageRoot,
  "src/generated/upstream-build-runtime.ts",
);

const readJsonFile = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));

const writeJsonFile = async (filePath, value) => {
  await writeFile(filePath, JSON.stringify(value, null, 2) + "\n");
};

const fetchText = async (url) => {
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  return response.text();
};

const fetchJson = async (url, { allowNotFound = false } = {}) => {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": USER_AGENT,
    },
  });

  if (allowNotFound && response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  return response.json();
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const getOptionValue = (argv, name) => {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
};

export const sanitizeRequestedVersion = (input) => input.trim().replace(/^v/, "");

export const parseVersion = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match)
    throw new Error(`Expected a stable semver version, received ${JSON.stringify(version)}`);

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
};

export const compareVersions = (left, right) => {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);

  if (leftParts.major !== rightParts.major) return leftParts.major - rightParts.major;
  if (leftParts.minor !== rightParts.minor) return leftParts.minor - rightParts.minor;
  return leftParts.patch - rightParts.patch;
};

export const toReleaseVersion = (windmillVersion) => {
  const { major, minor } = parseVersion(windmillVersion);
  return `${major}.${minor}.0`;
};

export const toReleaseLineLabel = (windmillVersion) => {
  const { major, minor } = parseVersion(windmillVersion);
  return `${major}.${minor}.x`;
};

export const toWindmillTag = (windmillVersion) => `v${windmillVersion}`;

export const getRuntimeSourceUrl = (windmillVersion) =>
  `https://raw.githubusercontent.com/${WINDMILL_REPOSITORY}/${toWindmillTag(
    windmillVersion,
  )}/${RAW_RUNTIME_PATH}`;

export const resolveWindmillVersion = async (requestedVersion) => {
  const packageMetadata = await fetchJson(`${REGISTRY_BASE_URL}/${WINDMILL_CLIENT_PACKAGE_NAME}`);
  const publishedVersions = Object.keys(packageMetadata.versions ?? {}).filter((version) =>
    /^\d+\.\d+\.\d+$/.test(version),
  );

  if (!requestedVersion) {
    const latestVersion = packageMetadata["dist-tags"]?.latest;
    if (typeof latestVersion !== "string") {
      throw new Error(`Unable to resolve the latest ${WINDMILL_CLIENT_PACKAGE_NAME} version`);
    }
    return sanitizeRequestedVersion(latestVersion);
  }

  const normalizedInput = sanitizeRequestedVersion(requestedVersion);
  if (/^\d+\.\d+$/.test(normalizedInput)) {
    const matchedVersions = publishedVersions
      .filter((version) => version.startsWith(`${normalizedInput}.`))
      .toSorted(compareVersions);
    const latestPatch = matchedVersions.at(-1);
    if (!latestPatch) {
      throw new Error(
        `Unable to find a published ${WINDMILL_CLIENT_PACKAGE_NAME} version for ${normalizedInput}.x`,
      );
    }
    return latestPatch;
  }

  parseVersion(normalizedInput);
  if (!publishedVersions.includes(normalizedInput)) {
    throw new Error(`${WINDMILL_CLIENT_PACKAGE_NAME}@${normalizedInput} is not published on npm`);
  }

  return normalizedInput;
};

export const getPublishedPluginVersions = async () => {
  const packageMetadata = await fetchJson(`${REGISTRY_BASE_URL}/${PLUGIN_PACKAGE_NAME}`, {
    allowNotFound: true,
  });

  if (!packageMetadata) return [];
  return Object.keys(packageMetadata.versions ?? {}).filter((version) =>
    /^\d+\.\d+\.\d+$/.test(version),
  );
};

export const renderCompatibilityBlock = ({ windmillVersion }) => {
  const releaseVersion = toReleaseVersion(windmillVersion);
  const releaseLineLabel = toReleaseLineLabel(windmillVersion);

  return [
    COMPATIBILITY_BLOCK_START,
    `Current release line: \`${releaseLineLabel}\``,
    "",
    `It currently depends on \`${WINDMILL_CLIENT_PACKAGE_NAME}@^${releaseVersion}\` and bundles \`rawAppWmillTs.ts\` generated from \`${WINDMILL_REPOSITORY}@${toWindmillTag(windmillVersion)}\`.`,
    COMPATIBILITY_BLOCK_END,
  ].join("\n");
};

export const replaceCompatibilityBlock = (readme, options) => {
  if (!readme.includes(COMPATIBILITY_BLOCK_START) || !readme.includes(COMPATIBILITY_BLOCK_END)) {
    throw new Error("README.md is missing the Windmill compatibility block markers");
  }

  const blockPattern = new RegExp(
    `${escapeRegExp(COMPATIBILITY_BLOCK_START)}[\\s\\S]*?${escapeRegExp(COMPATIBILITY_BLOCK_END)}`,
  );

  return readme.replace(blockPattern, renderCompatibilityBlock(options));
};

export const writeGeneratedRuntimeFile = async ({ windmillVersion }) => {
  const sourceUrl = getRuntimeSourceUrl(windmillVersion);
  const source = await fetchText(sourceUrl);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      newLine: ts.NewLineKind.LineFeed,
      removeComments: false,
      target: ts.ScriptTarget.ES2020,
    },
  });

  const normalizedSource = transpiled.outputText.trimEnd() + "\n";
  const generatedFile = `// Generated by scripts/sync-upstream-runtime.mjs
// Source: ${sourceUrl}

export const UPSTREAM_WINDMILL_VERSION = ${JSON.stringify(windmillVersion)}
export const UPSTREAM_WINDMILL_RELEASE_VERSION = ${JSON.stringify(toReleaseVersion(windmillVersion))}
export const UPSTREAM_WINDMILL_RELEASE_LINE = ${JSON.stringify(toReleaseLineLabel(windmillVersion))}
export const UPSTREAM_RAW_APP_WMILL_TS_REF = ${JSON.stringify(toWindmillTag(windmillVersion))}
export const UPSTREAM_RAW_APP_WMILL_TS_URL = ${JSON.stringify(sourceUrl)}
export const buildRuntimeSource = ${JSON.stringify(normalizedSource)}
`;

  await mkdir(path.dirname(generatedRuntimePath), { recursive: true });
  await writeFile(generatedRuntimePath, generatedFile);

  return {
    outputPath: generatedRuntimePath,
    relativeOutputPath: path.relative(packageRoot, generatedRuntimePath),
    sourceUrl,
  };
};

export const getReleaseStatus = async ({ requestedVersion } = {}) => {
  const packageJson = await readJsonFile(packageJsonPath);
  const windmillVersion = await resolveWindmillVersion(requestedVersion);
  const latestWindmillVersion = await resolveWindmillVersion();
  const releaseVersion = toReleaseVersion(windmillVersion);
  const latestReleaseVersion = toReleaseVersion(latestWindmillVersion);
  const publishedPluginVersions = await getPublishedPluginVersions();
  const published = publishedPluginVersions.includes(releaseVersion);

  return {
    currentPackageVersion: packageJson.version,
    currentWindmillClientRange: packageJson.dependencies?.[WINDMILL_CLIENT_PACKAGE_NAME] ?? null,
    isLatestReleaseLine: releaseVersion === latestReleaseVersion,
    latestReleaseVersion,
    latestWindmillVersion,
    packageName: packageJson.name,
    published,
    releaseVersion,
    releaseTag: `v${releaseVersion}`,
    requestedVersion: requestedVersion ?? null,
    shouldRelease: !published,
    windmillVersion,
  };
};

export const prepareRelease = async ({ requestedVersion } = {}) => {
  const packageJson = await readJsonFile(packageJsonPath);
  const windmillVersion = await resolveWindmillVersion(requestedVersion);
  const releaseVersion = toReleaseVersion(windmillVersion);

  packageJson.version = releaseVersion;
  packageJson.dependencies ??= {};
  packageJson.dependencies[WINDMILL_CLIENT_PACKAGE_NAME] = `^${releaseVersion}`;
  await writeJsonFile(packageJsonPath, packageJson);

  const readme = await readFile(readmePath, "utf8");
  await writeFile(readmePath, replaceCompatibilityBlock(readme, { windmillVersion }));

  const runtimeResult = await writeGeneratedRuntimeFile({ windmillVersion });

  return {
    releaseVersion,
    releaseTag: `v${releaseVersion}`,
    runtimeSourceUrl: runtimeResult.sourceUrl,
    windmillClientRange: packageJson.dependencies[WINDMILL_CLIENT_PACKAGE_NAME],
    windmillVersion,
  };
};
