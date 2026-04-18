import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  collectAppFiles,
  generateRawAppPolicy,
  inferBase,
  inferPath,
  loadRawAppProject,
  loadRunnablesFromBackend,
  resolveProject,
} from "../src/project.ts";

const tempDirs: string[] = [];
const TEST_BASE_URL = "https://windmill.example.com";
const TEST_WORKSPACE = "example-workspace";
const TEST_TOKEN = "token";

const originalEnv = {
  BASE_INTERNAL_URL: process.env.BASE_INTERNAL_URL,
  WM_TOKEN: process.env.WM_TOKEN,
  WM_WORKSPACE: process.env.WM_WORKSPACE,
};

const createTempWorkspace = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vite-plugin-windmill-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await import("node:fs/promises").then(async ({ rm }) =>
        rm(dir, { force: true, recursive: true }),
      );
    }),
  );
});

afterEach(() => {
  if (originalEnv.BASE_INTERNAL_URL === undefined) delete process.env.BASE_INTERNAL_URL;
  else process.env.BASE_INTERNAL_URL = originalEnv.BASE_INTERNAL_URL;

  if (originalEnv.WM_TOKEN === undefined) delete process.env.WM_TOKEN;
  else process.env.WM_TOKEN = originalEnv.WM_TOKEN;

  if (originalEnv.WM_WORKSPACE === undefined) delete process.env.WM_WORKSPACE;
  else process.env.WM_WORKSPACE = originalEnv.WM_WORKSPACE;
});

describe("path inference", () => {
  it("infers the raw app path from the workspace root", () => {
    expect(inferPath("/repo/f/apps/example.raw_app", "/repo")).toBe("f/apps/example");
    expect(inferBase("f/apps/example")).toBe("/apps_raw/get/f/apps/example/");
  });

  it("rejects directories that are not raw-app folders", () => {
    expect(() => inferPath("/repo/f/apps/example", "/repo")).toThrow(
      "Expected /repo/f/apps/example to end in .raw_app or __raw_app so the app path can be inferred",
    );
  });
});

describe("project loading", () => {
  it("loads backend runnables from code and yaml files", async () => {
    const workspaceDir = await createTempWorkspace();
    const dir = path.join(workspaceDir, "f", "apps", "demo.raw_app");
    const backendDir = path.join(dir, "backend");
    const srcDir = path.join(dir, "src");

    await mkdir(backendDir, { recursive: true });
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      path.join(workspaceDir, "wmill.yaml"),
      ["defaultTs: bun", "excludes:", "  - f/apps/demo.raw_app/src/**", ""].join("\n"),
    );
    await writeFile(path.join(dir, "raw_app.yaml"), "summary: Demo\n");
    await writeFile(path.join(dir, "index.tsx"), "export {}\n");
    await writeFile(path.join(dir, "keep.txt"), "kept\n");
    await writeFile(path.join(dir, "AGENTS.md"), "ignored\n");
    await writeFile(path.join(srcDir, "main.tsx"), 'console.log("excluded")\n');
    await writeFile(path.join(backendDir, "hello.my.sql"), "select 1\n");
    await writeFile(path.join(backendDir, "hello.yaml"), "type: inline\n");
    await writeFile(path.join(backendDir, "ping.py"), "def main():\n    return 1\n");

    process.env.WM_WORKSPACE = TEST_WORKSPACE;
    process.env.WM_TOKEN = TEST_TOKEN;
    process.env.BASE_INTERNAL_URL = TEST_BASE_URL;

    const project = await resolveProject({ dir });
    const runnables = await loadRunnablesFromBackend(backendDir);
    const files = await collectAppFiles(dir, {
      excludes: project.syncExcludes,
      root: project.root,
    });
    const rawAppProject = await loadRawAppProject(project);

    expect(runnables.hello.inlineScript?.language).toBe("mysql");
    expect(runnables.ping.inlineScript?.language).toBe("python3");
    expect(files).toEqual({
      "/index.tsx": "export {}\n",
      "/keep.txt": "kept\n",
    });
    expect(Object.keys(rawAppProject.runnables)).toEqual(["hello", "ping"]);
  });

  it("builds triggerables_v2 for inline and path runnables", async () => {
    const policy = await generateRawAppPolicy(
      {
        inline_task: {
          fields: {
            limit: { type: "static", value: 10 },
            resource: { allowUserResources: true, type: "user" },
          },
          inlineScript: { content: "export async function main() {}", language: "bun" },
          type: "inline",
        },
        script_task: {
          fields: {},
          path: "f/apps/task",
          runType: "script",
          type: "path",
        },
      },
      {},
      false,
    );

    expect(policy.execution_mode).toBe("publisher");
    const inlineEntry = Object.entries(policy.triggerables_v2 ?? {}).find(([key]) =>
      key.startsWith("inline_task:rawscript/"),
    );

    expect(inlineEntry).toBeDefined();
    expect(inlineEntry?.[1]).toEqual({
      allow_user_resources: ["resource"],
      one_of_inputs: {},
      static_inputs: { limit: 10 },
    });
    expect(policy.triggerables_v2).toMatchObject({
      "script_task:script/f/apps/task": {
        allow_user_resources: [],
        one_of_inputs: {},
        static_inputs: {},
      },
    });
  });

  it("prefers explicit options over environment values when resolving a project", async () => {
    const workspaceDir = await createTempWorkspace();
    const dir = path.join(workspaceDir, "f", "apps", "demo.raw_app");

    await mkdir(dir, { recursive: true });
    await writeFile(path.join(workspaceDir, "wmill.yaml"), "defaultTs: bun\n");
    await writeFile(path.join(dir, "raw_app.yaml"), "summary: Demo\n");
    await writeFile(path.join(dir, "index.tsx"), "export {}\n");

    process.env.WM_WORKSPACE = "env-workspace";
    process.env.WM_TOKEN = "env-token";
    process.env.BASE_INTERNAL_URL = "https://env.example.com";

    const project = await resolveProject({
      dir,
      path: "f/overrides/custom",
      token: "option-token",
      url: "https://option.example.com",
      workspace: "option-workspace",
    });

    expect(project.base).toBe("/apps_raw/get/f/overrides/custom/");
    expect(project.path).toBe("f/overrides/custom");
    expect(project.token).toBe("option-token");
    expect(project.url).toBe("https://option.example.com");
    expect(project.workspace).toBe("option-workspace");
  });

  it("loads config-defined runnables and dereferences !inline files", async () => {
    const workspaceDir = await createTempWorkspace();
    const dir = path.join(workspaceDir, "f", "apps", "demo.raw_app");
    const backendDir = path.join(dir, "backend");

    await mkdir(backendDir, { recursive: true });
    await writeFile(path.join(workspaceDir, "wmill.yaml"), "defaultTs: bun\n");
    await writeFile(path.join(dir, "index.tsx"), "export {}\n");
    await writeFile(path.join(backendDir, "query.sql"), "select 1\n");
    await writeFile(
      path.join(dir, "raw_app.yaml"),
      [
        "summary: Demo",
        "runnables:",
        "  inline_task:",
        "    type: inline",
        "    inlineScript:",
        "      language: bun",
        '      content: "!inline query.sql"',
        "",
      ].join("\n"),
    );

    const project = await resolveProject({ dir });
    const rawAppProject = await loadRawAppProject(project);

    expect(rawAppProject.runnables.inline_task.inlineScript?.content).toBe("select 1\n");
    const inlineEntry = Object.entries(rawAppProject.policy.triggerables_v2 ?? {}).find(([key]) =>
      key.startsWith("inline_task:rawscript/"),
    );

    expect(inlineEntry?.[1]).toEqual({
      allow_user_resources: [],
      one_of_inputs: {},
      static_inputs: {},
    });
  });
});
