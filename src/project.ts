import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Policy } from "windmill-client";
import { parse } from "yaml";

import type {
  PluginOptions,
  Project,
  RawAppField,
  RawAppFileConfig,
  RawAppProject,
  RawAppRunnable,
} from "./types.ts";

const WMILL_IMPORT_PATTERN = /^(?:\.\/|\/)?wmill(?:\.ts)?$|^(?:\.\.\/)+wmill(?:\.ts)?$/;
const RAW_APP_FOLDER_SUFFIXES = [".raw_app", "__raw_app"] as const;
const RAW_APP_FILE_NAME = "raw_app.yaml";
const WMILL_CONFIG_FILE_NAME = "wmill.yaml";
const DEPLOY_IGNORED_FILE_NAMES = new Set([
  "AGENTS.md",
  "DATATABLES.md",
  "package-lock.json",
  "raw_app.yaml",
  "wmill.d.ts",
]);
const DEPLOY_IGNORED_DIRECTORIES = new Set([
  ".claude",
  "backend",
  "dist",
  "node_modules",
  "sql_to_apply",
]);

const LANGUAGE_BY_EXTENSION = {
  "bq.sql": "bigquery",
  "bun.ts": "bun",
  cs: "csharp",
  "deno.ts": "deno",
  "duckdb.sql": "duckdb",
  "frontend.js": "frontend",
  go: "go",
  gql: "graphql",
  java: "java",
  "ms.sql": "mssql",
  "my.sql": "mysql",
  "native.ts": "nativets",
  nu: "nu",
  "odb.sql": "oracledb",
  "pg.sql": "postgresql",
  php: "php",
  "playbook.yml": "ansible",
  ps1: "powershell",
  py: "python3",
  rb: "ruby",
  rs: "rust",
  "sf.sql": "snowflake",
  sh: "bash",
  ts: "bun",
} as const satisfies Record<string, string>;

const isNodeError = (value: unknown): value is NodeJS.ErrnoException =>
  value instanceof Error && "code" in value;

const pathExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const normalizeToPosix = (value: string): string => value.split(path.sep).join("/");

const dirnameIfPossible = (value: string): string | undefined => {
  const parent = path.dirname(value);
  return parent === value ? undefined : parent;
};

const findUp = async (startDir: string, fileName: string): Promise<string | undefined> => {
  let currentDir = path.resolve(startDir);

  while (true) {
    const candidate = path.join(currentDir, fileName);
    if (await pathExists(candidate)) return candidate;

    const parentDir = dirnameIfPossible(currentDir);
    if (!parentDir) return undefined;

    currentDir = parentDir;
  }
};

const parseYamlFile = async <T>(filePath: string): Promise<T> => {
  const content = await readFile(filePath, "utf8");
  return parse(content) as T;
};

const resolveRoot = async (
  explicitRoot: string | undefined,
  dir: string,
): Promise<{ path?: string; root: string }> => {
  if (explicitRoot) {
    const root = path.resolve(explicitRoot);
    return {
      path: (await pathExists(path.join(root, WMILL_CONFIG_FILE_NAME)))
        ? path.join(root, WMILL_CONFIG_FILE_NAME)
        : undefined,
      root,
    };
  }

  const configPath = await findUp(dir, WMILL_CONFIG_FILE_NAME);
  return {
    path: configPath,
    root: configPath ? path.dirname(configPath) : dir,
  };
};

const resolveDir = async (explicitDir: string | undefined): Promise<string> => {
  const candidate = path.resolve(explicitDir ?? process.cwd());
  const rawAppPath = await findUp(candidate, RAW_APP_FILE_NAME);
  if (!rawAppPath) throw new Error(`Could not find ${RAW_APP_FILE_NAME} from ${candidate}`);

  return path.dirname(rawAppPath);
};

const stripRawAppSuffix = (folderName: string): string | undefined => {
  for (const suffix of RAW_APP_FOLDER_SUFFIXES)
    if (folderName.endsWith(suffix)) return folderName.slice(0, -suffix.length);

  return undefined;
};

export const inferPath = (dir: string, root: string): string => {
  const relativePath = normalizeToPosix(path.relative(root, dir));
  const segments = relativePath.split("/").filter(Boolean);
  if (segments.length === 0) throw new Error(`Could not infer a Windmill app path from ${dir}`);

  const lastSegment = segments.at(-1);
  if (!lastSegment) throw new Error(`Could not infer a Windmill app path from ${dir}`);

  const strippedSegment = stripRawAppSuffix(lastSegment);
  if (!strippedSegment) {
    throw new Error(
      `Expected ${dir} to end in .raw_app or __raw_app so the app path can be inferred`,
    );
  }

  return [...segments.slice(0, -1), strippedSegment].join("/");
};

export const inferBase = (pathValue: string): string => `/apps_raw/get/${pathValue}/`;

const resolveEntry = async (dir: string, value: string | undefined): Promise<string> => {
  if (value) {
    const entry = path.resolve(dir, value);
    if (!(await pathExists(entry))) throw new Error(`Entry file does not exist: ${entry}`);

    return entry;
  }

  const tsEntry = path.join(dir, "index.ts");
  if (await pathExists(tsEntry)) return tsEntry;

  const tsxEntry = path.join(dir, "index.tsx");
  if (await pathExists(tsxEntry)) return tsxEntry;

  throw new Error(`Could not find index.ts or index.tsx inside ${dir}`);
};

const resolveEnv = (options: PluginOptions) => ({
  url: options.url ?? process.env.BASE_INTERNAL_URL ?? process.env.BASE_URL,
  token: options.token ?? process.env.WM_TOKEN,
  workspace: options.workspace ?? process.env.WM_WORKSPACE,
});

export const resolveProject = async (options: PluginOptions = {}): Promise<Project> => {
  const dir = await resolveDir(options.dir);
  const { path: config, root } = await resolveRoot(options.root, dir);
  const wmillConfig = config
    ? await parseYamlFile<{ defaultTs?: string; excludes?: string[]; nonDottedPaths?: boolean }>(
        config,
      )
    : {};
  const pathValue = options.path ?? inferPath(dir, root);
  const entry = await resolveEntry(dir, options.entry);
  const { url, token, workspace } = resolveEnv(options);

  return {
    base: options.base ?? inferBase(pathValue),
    config,
    dir,
    entry,
    nonDotted: options.nonDotted ?? wmillConfig.nonDottedPaths ?? false,
    path: pathValue,
    root,
    syncExcludes: wmillConfig.excludes ?? [],
    ts: options.ts ?? wmillConfig.defaultTs ?? "bun",
    workspace,
    token,
    url,
    yaml: path.join(dir, RAW_APP_FILE_NAME),
  };
};

const collectStaticFields = (fields: Record<string, RawAppField> | undefined) =>
  Object.fromEntries(
    Object.entries(fields ?? {})
      .filter(([, field]) => field.type === "static")
      .map(([name, field]) => [name, field.value]),
  );

const createRawscriptHash = (content: string | undefined): string =>
  createHash("sha256")
    .update(content ?? "")
    .digest("hex");

const resolveTriggerableEntry = async (
  runnableId: string,
  runnable: RawAppRunnable,
): Promise<
  | [
      string,
      { allow_user_resources: string[]; one_of_inputs: {}; static_inputs: Record<string, unknown> },
    ]
  | undefined
> => {
  const staticInputs = collectStaticFields(runnable.fields);
  const allowUserResources = Object.entries(runnable.fields ?? {})
    .filter(([, field]) => field.allowUserResources)
    .map(([name]) => name);

  if (runnable.inlineScript) {
    return [
      `${runnableId}:rawscript/${createRawscriptHash(runnable.inlineScript.content)}`,
      { allow_user_resources: allowUserResources, one_of_inputs: {}, static_inputs: staticInputs },
    ];
  }

  if (runnable.path && runnable.runType) {
    const runType = runnable.runType === "hubscript" ? "script" : runnable.runType;
    return [
      `${runnableId}:${runType}/${runnable.path}`,
      { allow_user_resources: allowUserResources, one_of_inputs: {}, static_inputs: staticInputs },
    ];
  }

  return undefined;
};

export const generateRawAppPolicy = async (
  runnables: Record<string, RawAppRunnable>,
  policy: RawAppFileConfig["policy"],
  isPublic: boolean,
): Promise<Policy> => {
  const triggerableEntries = await Promise.all(
    Object.entries(runnables).map(async ([runnableId, runnable]) =>
      resolveTriggerableEntry(runnableId, runnable),
    ),
  );

  const resolvedTriggerableEntries = triggerableEntries.filter(
    (
      entry,
    ): entry is [
      string,
      { allow_user_resources: string[]; one_of_inputs: {}; static_inputs: Record<string, unknown> },
    ] => entry !== undefined,
  );

  return {
    ...policy,
    execution_mode: isPublic ? "anonymous" : "publisher",
    triggerables_v2: Object.fromEntries(resolvedTriggerableEntries),
  };
};

const resolveRunnableLanguage = (extension: string, ts: string): string | undefined => {
  const language = LANGUAGE_BY_EXTENSION[extension as keyof typeof LANGUAGE_BY_EXTENSION];
  if (!language) return undefined;

  return extension === "ts" ? ts : language;
};

const findRunnableContentFile = async (
  backendDir: string,
  runnableId: string,
  allFileNames: string[],
): Promise<{ content: string; extension: string } | undefined> => {
  for (const fileName of allFileNames) {
    if (fileName.endsWith(".yaml") || fileName.endsWith(".lock")) continue;

    if (!fileName.startsWith(`${runnableId}.`)) continue;

    const extension = fileName.slice(runnableId.length + 1);
    if (!resolveRunnableLanguage(extension, "bun")) continue;

    return {
      content: await readFile(path.join(backendDir, fileName), "utf8"),
      extension,
    };
  }

  return undefined;
};

const getRunnableIdFromCodeFile = (fileName: string): string | undefined => {
  if (fileName.endsWith(".yaml") || fileName.endsWith(".lock")) return undefined;

  for (const extension of Object.keys(LANGUAGE_BY_EXTENSION))
    if (fileName.endsWith(`.${extension}`)) return fileName.slice(0, -(extension.length + 1));

  return undefined;
};

const inlinePathPrefix = "!inline ";

const dereferenceInlineValue = async (value: unknown, localPath: string): Promise<unknown> => {
  if (typeof value !== "string" || !value.startsWith(inlinePathPrefix)) return value;

  const relativePath = value.slice(inlinePathPrefix.length);
  return readFile(path.join(localPath, relativePath), "utf8");
};

const cloneRunnable = async (value: unknown, localPath: string): Promise<unknown> => {
  if (Array.isArray(value))
    return Promise.all(value.map(async (item) => cloneRunnable(item, localPath)));

  if (typeof value !== "object" || value === null) return dereferenceInlineValue(value, localPath);

  const entries = await Promise.all(
    Object.entries(value).map(async ([key, entryValue]) => [
      key,
      await cloneRunnable(entryValue, localPath),
    ]),
  );

  return Object.fromEntries(entries);
};

export const loadRunnablesFromBackend = async (
  backendDir: string,
  ts = "bun",
): Promise<Record<string, RawAppRunnable>> => {
  const runnables: Record<string, RawAppRunnable> = {};

  try {
    const entries = await readdir(backendDir, { withFileTypes: true });
    const allFileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    const processedIds = new Set<string>();

    for (const fileName of allFileNames) {
      if (!fileName.endsWith(".yaml")) continue;

      const runnableId = fileName.slice(0, -".yaml".length);
      processedIds.add(runnableId);
      const runnable = await parseYamlFile<RawAppRunnable>(path.join(backendDir, fileName));
      if (runnable.type === "inline") {
        const contentFile = await findRunnableContentFile(backendDir, runnableId, allFileNames);
        if (contentFile) {
          const lockPath = path.join(backendDir, `${runnableId}.lock`);
          let lock: string | undefined;
          try {
            lock = await readFile(lockPath, "utf8");
          } catch (error) {
            if (!isNodeError(error) || error.code !== "ENOENT") throw error;
          }

          runnable.inlineScript = {
            ...runnable.inlineScript,
            content: contentFile.content,
            language: resolveRunnableLanguage(contentFile.extension, ts),
            ...(lock ? { lock } : {}),
          };
        }
      } else if (
        runnable.type === "flow" ||
        runnable.type === "hubscript" ||
        runnable.type === "script"
      ) {
        const { type, schema: _schema, ...rest } = runnable;
        runnables[runnableId] = {
          ...rest,
          runType: type,
          type: "path",
        };
        continue;
      }

      runnables[runnableId] = runnable;
    }

    for (const fileName of allFileNames) {
      const runnableId = getRunnableIdFromCodeFile(fileName);
      if (!runnableId || processedIds.has(runnableId)) continue;

      processedIds.add(runnableId);
      const contentFile = await findRunnableContentFile(backendDir, runnableId, allFileNames);
      if (!contentFile) continue;

      const lockPath = path.join(backendDir, `${runnableId}.lock`);
      let lock: string | undefined;
      try {
        lock = await readFile(lockPath, "utf8");
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }

      runnables[runnableId] = {
        inlineScript: {
          content: contentFile.content,
          language: resolveRunnableLanguage(contentFile.extension, ts),
          ...(lock ? { lock } : {}),
        },
        type: "inline",
      };
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }

  return runnables;
};

const matchesSyncExclude = (relativePath: string, excludes: string[]): boolean =>
  excludes.some((pattern) => path.posix.matchesGlob(relativePath, pattern));

export const collectAppFiles = async (
  dir: string,
  options: { excludes?: string[]; root?: string } = {},
): Promise<Record<string, string>> => {
  const files: Record<string, string> = {};
  const root = options.root ? path.resolve(options.root) : dir;
  const excludes = options.excludes ?? [];

  const walk = async (currentDir: string, relativeDir = "/"): Promise<void> => {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = `${relativeDir}${entry.name}`;
      const relativeToRoot = normalizeToPosix(path.relative(root, fullPath));

      if (entry.isDirectory()) {
        if (DEPLOY_IGNORED_DIRECTORIES.has(entry.name)) continue;

        await walk(fullPath, `${relativePath}/`);
        continue;
      }

      if (DEPLOY_IGNORED_FILE_NAMES.has(entry.name)) continue;
      if (matchesSyncExclude(relativeToRoot, excludes)) continue;

      files[relativePath] = await readFile(fullPath, "utf8");
    }
  };

  await walk(dir);
  return files;
};

export const loadRawAppProject = async (project: Project): Promise<RawAppProject> => {
  const config = await parseYamlFile<RawAppFileConfig>(project.yaml);
  const backendDir = path.join(project.dir, "backend");
  const backendRunnables = await loadRunnablesFromBackend(backendDir, project.ts);
  const rawRunnables =
    Object.keys(backendRunnables).length > 0 ? backendRunnables : (config.runnables ?? {});
  const runnables = (await cloneRunnable(rawRunnables, backendDir)) as Record<
    string,
    RawAppRunnable
  >;
  const files = await collectAppFiles(project.dir, {
    excludes: project.syncExcludes,
    root: project.root,
  });
  const policy = await generateRawAppPolicy(runnables, config.policy, Boolean(config.public));
  const value = {
    ...(config.data !== undefined ? { data: config.data } : {}),
    files,
    runnables,
  };

  return {
    config,
    files,
    policy,
    runnables,
    value,
  };
};

const createArgsType = (_runnable: RawAppRunnable): string => "{}";

const generateWmillDts = (
  runnables: Record<string, RawAppRunnable>,
): string => `// THIS FILE IS READ-ONLY
// AND GENERATED AUTOMATICALLY FROM YOUR RUNNABLES

export declare const backend: {
${Object.entries(runnables)
  .map(([name, runnable]) => `  ${name}: (args: ${createArgsType(runnable)}) => Promise<any>`)
  .join("\n")}
}

export declare const backendAsync: {
${Object.entries(runnables)
  .map(([name, runnable]) => `  ${name}: (args: ${createArgsType(runnable)}) => Promise<string>`)
  .join("\n")}
}

export type Job = {
  type: 'QueuedJob' | 'CompletedJob'
  id: string
  created_at: number
  started_at: number | undefined
  duration_ms: number
  success: boolean
  args: any
  result: any
}

export declare function waitJob(id: string): Promise<Job>
export declare function getJob(id: string): Promise<Job>

export type StreamUpdate = {
  new_result_stream?: string
  stream_offset?: number
}

export declare function streamJob(id: string, onUpdate?: (data: StreamUpdate) => void): Promise<any>
`;

export const writeGeneratedWmillTypes = async (project: Project): Promise<void> => {
  const rawAppProject = await loadRawAppProject(project);
  const filePath = path.join(project.dir, "wmill.d.ts");
  const contents = generateWmillDts(rawAppProject.runnables);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
};

export { WMILL_IMPORT_PATTERN };
