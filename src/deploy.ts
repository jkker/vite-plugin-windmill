import { readFile } from "node:fs/promises";
import path from "node:path";

import { ApiError, AppService, setClient } from "windmill-client";

import { loadRawAppProject, resolveProject } from "./project.ts";
import type { BundleContents, DeployOptions, DeployRawAppResult, Project } from "./types.ts";

const defaultDeploymentMessage = () => {
  const sha = process.env.GITHUB_SHA;
  return sha ? `vite-plugin-windmill deploy ${sha}` : "vite-plugin-windmill deploy";
};

const requireProjectConnection = (project: Project) => {
  if (!project.workspace)
    throw new Error("Missing Windmill workspace. Set `workspace` or `WM_WORKSPACE`.");

  if (!project.token) throw new Error("Missing Windmill token. Set `token` or `WM_TOKEN`.");

  if (!project.url)
    throw new Error("Missing Windmill URL. Set `url`, `BASE_INTERNAL_URL`, or `BASE_URL`.");

  return {
    url: project.url,
    token: project.token,
    workspace: project.workspace,
  };
};

const readBundleFile = async (filePath: string, fallback = ""): Promise<string> => {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return fallback;

    throw error;
  }
};

const readBundleContents = async (
  dir: string,
  js = path.join(dir, "dist/windmill/bundle.js"),
  css = path.join(dir, "dist/windmill/bundle.css"),
): Promise<BundleContents> => ({
  css: await readBundleFile(css, ""),
  js: await readBundleFile(js),
});

const findExistingRawApp = async (workspace: string, pathValue: string) => {
  try {
    return await AppService.getAppByPath({
      workspace,
      path: pathValue,
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return undefined;

    throw error;
  }
};

/**
 * Deploys a raw app to Windmill using `windmill-client` instead of shelling out to the CLI.
 */
export const deploy = async (options: DeployOptions): Promise<DeployRawAppResult> => {
  const dir = options.dir ?? process.cwd();
  const project = await resolveProject({ ...options, dir });
  const rawAppProject = await loadRawAppProject(project);
  const connection = requireProjectConnection(project);
  const bundles = options.bundles ?? (await readBundleContents(dir, options.js, options.css));

  if (!bundles.js) throw new Error("Cannot deploy a Windmill raw app without a JavaScript bundle");

  if (options.dry) {
    return {
      action: "dry-run",
      base: project.base,
      path: project.path,
      workspace: connection.workspace,
    };
  }

  setClient(connection.token, connection.url);

  const existingApp = await findExistingRawApp(connection.workspace, project.path);

  if (existingApp && !existingApp.raw_app)
    throw new Error(`${project.path} exists remotely but is not a raw app`);

  const message = options.message ?? defaultDeploymentMessage();
  const appPayload = {
    ...(rawAppProject.config.custom_path ? { custom_path: rawAppProject.config.custom_path } : {}),
    deployment_message: message,
    path: project.path,
    policy: rawAppProject.policy,
    summary: rawAppProject.config.summary,
    value: rawAppProject.value,
  };

  if (existingApp) {
    await AppService.updateAppRaw({
      workspace: connection.workspace,
      path: project.path,
      formData: {
        app: appPayload,
        css: bundles.css,
        js: bundles.js,
      },
    });
    return {
      action: "update",
      base: project.base,
      path: project.path,
      workspace: connection.workspace,
    };
  }

  await AppService.createAppRaw({
    workspace: connection.workspace,
    formData: {
      app: appPayload,
      css: bundles.css,
      js: bundles.js,
    },
  });

  return {
    action: "create",
    base: project.base,
    path: project.path,
    workspace: connection.workspace,
  };
};
