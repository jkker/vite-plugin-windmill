import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";
import type { OutputAsset, OutputBundle, OutputChunk } from "vite/rolldown";

import windmill from "../src/plugin.ts";

type WindmillPlugin = ReturnType<typeof windmill>;
type HookFunction = (...args: never[]) => unknown;
type ConfigHook = Extract<WindmillPlugin["config"], HookFunction>;
type ConfigHookContext = ThisParameterType<ConfigHook>;
type ConfigHookEnv = Parameters<ConfigHook>[1];
type LoadHook = Extract<WindmillPlugin["load"], HookFunction>;
type PluginHookContext = ThisParameterType<LoadHook>;
type WriteBundleHook = Extract<WindmillPlugin["writeBundle"], HookFunction>;

const tempDirs: string[] = [];

const RESOLVED_VIRTUAL_WMILL_ID = "\0virtual:vite-plugin-windmill/wmill";
const TEST_BASE_URL = "https://windmill.example.com";
const TEST_TOKEN = "test-token";
const TEST_WORKSPACE = "example-workspace";
type ManagedEnvKey = "BASE_URL" | "WM_WORKSPACE" | "WM_TOKEN" | "BASE_INTERNAL_URL" | "WM_DEPLOY";

const describeUnknown = (value: unknown): string => {
  if (typeof value === "string") return value;

  try {
    const serialized = JSON.stringify(value);
    if (serialized) return serialized;
  } catch {
    // Fall through to a stable tag-style description.
  }

  return Object.prototype.toString.call(value);
};

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(describeUnknown(error));

const createConfigPluginContext = (): ConfigHookContext => ({
  debug: () => {},
  error: (error: unknown) => {
    throw toError(error);
  },
  info: () => {},
  meta: {
    rollupVersion: "0.0.0-test",
    rolldownVersion: "0.0.0-test",
    viteVersion: "0.0.0-test",
  },
  warn: () => {},
});

const createPluginContext = (): PluginHookContext => ({
  addWatchFile: () => {},
  debug: () => {},
  emitFile: () => "test-reference",
  environment: {} as PluginHookContext["environment"],
  error: (error: unknown) => {
    throw toError(error);
  },
  fs: {} as PluginHookContext["fs"],
  getFileName: () => "generated-file",
  getModuleIds: () => new Set<string>().values(),
  getModuleInfo: () => null,
  info: () => {},
  load: async () => {
    throw new Error("Unexpected plugin-context load in test");
  },
  meta: {
    rollupVersion: "0.0.0-test",
    rolldownVersion: "0.0.0-test",
    viteVersion: "0.0.0-test",
    watchMode: false,
  },
  parse: () => {
    throw new Error("Unexpected plugin-context parse in test");
  },
  resolve: async () => null,
  warn: () => {},
});

const createInfoPluginContext = (messages: string[]): PluginHookContext => ({
  ...createPluginContext(),
  info: (message: unknown) => {
    messages.push(describeUnknown(message));
  },
});

const createTestBundle = (): OutputBundle => ({
  "bundle.css": {
    fileName: "bundle.css",
    name: "bundle.css",
    source: "body{}",
    type: "asset",
  } as OutputAsset,
  "bundle.js": {
    code: 'console.log("test")',
    fileName: "bundle.js",
    map: null,
    name: "bundle",
    type: "chunk",
  } as OutputChunk,
});

const createOutputOptions = (): Parameters<WriteBundleHook>[0] =>
  ({ dir: "dist/windmill" }) as Parameters<WriteBundleHook>[0];

const createTempWorkspace = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vite-plugin-windmill-"));
  tempDirs.push(dir);
  return dir;
};

const createMinimalRawApp = async (workspaceDir: string, appName = "test.raw_app") => {
  const dir = path.join(workspaceDir, "f", "app", appName);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(workspaceDir, "wmill.yaml"), "defaultTs: bun\n");
  await writeFile(path.join(dir, "raw_app.yaml"), "summary: Test App\n");
  await writeFile(path.join(dir, "index.tsx"), "export {}\n");
  return dir;
};

const runConfigHook = async (plugin: WindmillPlugin, root: string, env: ConfigHookEnv) => {
  if (!plugin.config || typeof plugin.config !== "function") throw new Error("config hook missing");

  return plugin.config.call(createConfigPluginContext(), { root }, env);
};

const restoreEnvVar = (key: ManagedEnvKey, value: string | undefined) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

const setWindmillEnv = () => {
  process.env.WM_WORKSPACE = TEST_WORKSPACE;
  process.env.WM_TOKEN = TEST_TOKEN;
  process.env.BASE_INTERNAL_URL = TEST_BASE_URL;
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

// Store original env vars
const originalEnv = {
  BASE_URL: process.env.BASE_URL,
  WM_WORKSPACE: process.env.WM_WORKSPACE,
  WM_TOKEN: process.env.WM_TOKEN,
  BASE_INTERNAL_URL: process.env.BASE_INTERNAL_URL,
  WM_DEPLOY: process.env.WM_DEPLOY,
};
afterEach(() => {
  restoreEnvVar("BASE_URL", originalEnv.BASE_URL);
  restoreEnvVar("WM_WORKSPACE", originalEnv.WM_WORKSPACE);
  restoreEnvVar("WM_TOKEN", originalEnv.WM_TOKEN);
  restoreEnvVar("BASE_INTERNAL_URL", originalEnv.BASE_INTERNAL_URL);
  restoreEnvVar("WM_DEPLOY", originalEnv.WM_DEPLOY);
});

describe("windmill plugin – serve mode", () => {
  it('sets base to "/" so Vite does not intercept /__windmill__/ routes', async () => {
    const workspaceDir = await createTempWorkspace();
    const dir = await createMinimalRawApp(workspaceDir);

    setWindmillEnv();

    const plugin = windmill({ dir });
    const config = await runConfigHook(plugin, dir, {
      command: "serve",
      mode: "development",
      isPreview: false,
    });

    expect(config?.base).toBe("/");
  });

  it("keeps appType custom so Vite does not add its own HTML serving", async () => {
    const workspaceDir = await createTempWorkspace();
    const dir = await createMinimalRawApp(workspaceDir);

    setWindmillEnv();

    const plugin = windmill({ dir });
    const config = await runConfigHook(plugin, dir, {
      command: "serve",
      mode: "development",
      isPreview: false,
    });

    expect(config?.appType).toBe("custom");
  });

  it("disables publicDir in serve mode", async () => {
    const workspaceDir = await createTempWorkspace();
    const dir = await createMinimalRawApp(workspaceDir);

    setWindmillEnv();

    const plugin = windmill({ dir });
    const config = await runConfigHook(plugin, dir, {
      command: "serve",
      mode: "development",
      isPreview: false,
    });

    expect(config?.publicDir).toBe(false);
  });

  it("adds an authenticated /api proxy from env defaults in serve mode", async () => {
    const workspaceDir = await createTempWorkspace();
    const dir = await createMinimalRawApp(workspaceDir);

    setWindmillEnv();

    const plugin = windmill({ dir });
    const config = await runConfigHook(plugin, dir, {
      command: "serve",
      mode: "development",
      isPreview: false,
    });

    expect(config?.server?.proxy).toMatchObject({
      "/api": {
        changeOrigin: true,
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
        target: TEST_BASE_URL,
      },
    });
    expect(config?.preview?.proxy).toMatchObject({
      "/api": {
        changeOrigin: true,
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
        target: TEST_BASE_URL,
      },
    });
  });

  it("falls back to BASE_URL when BASE_INTERNAL_URL is unset", async () => {
    const workspaceDir = await createTempWorkspace();
    const dir = await createMinimalRawApp(workspaceDir);

    process.env.WM_WORKSPACE = TEST_WORKSPACE;
    process.env.WM_TOKEN = TEST_TOKEN;
    delete process.env.BASE_INTERNAL_URL;
    process.env.BASE_URL = "https://public.windmill.example.com";

    const plugin = windmill({ dir });
    const config = await runConfigHook(plugin, dir, {
      command: "serve",
      mode: "development",
      isPreview: false,
    });

    expect(config?.server?.proxy).toMatchObject({
      "/api": {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
        target: "https://public.windmill.example.com",
      },
    });
  });

  it("allows overriding proxy settings from plugin options", async () => {
    const workspaceDir = await createTempWorkspace();
    const dir = await createMinimalRawApp(workspaceDir);

    process.env.WM_WORKSPACE = TEST_WORKSPACE;
    process.env.WM_TOKEN = "ignored-token";
    process.env.BASE_INTERNAL_URL = TEST_BASE_URL;

    const plugin = windmill({
      dir,
      proxy: {
        context: "/wm-api",
        headers: { "x-test-proxy": "1" },
        target: "https://proxy.example.com",
        token: "override-token",
      },
    });
    const config = await runConfigHook(plugin, dir, {
      command: "serve",
      mode: "development",
      isPreview: false,
    });

    expect(config?.server?.proxy).toMatchObject({
      "/wm-api": {
        changeOrigin: true,
        headers: {
          Authorization: "Bearer override-token",
          "x-test-proxy": "1",
        },
        target: "https://proxy.example.com",
      },
    });
  });

  it("preserves an explicit Authorization header on the proxy", async () => {
    const workspaceDir = await createTempWorkspace();
    const dir = await createMinimalRawApp(workspaceDir);

    setWindmillEnv();

    const plugin = windmill({
      dir,
      proxy: {
        headers: { Authorization: "Bearer explicit-token" },
      },
    });
    const config = await runConfigHook(plugin, dir, {
      command: "serve",
      mode: "development",
      isPreview: false,
    });

    expect(config?.server?.proxy).toMatchObject({
      "/api": {
        headers: { Authorization: "Bearer explicit-token" },
        target: TEST_BASE_URL,
      },
    });
  });

  it("allows disabling the shared API proxy", async () => {
    const workspaceDir = await createTempWorkspace();
    const dir = await createMinimalRawApp(workspaceDir);

    setWindmillEnv();

    const plugin = windmill({ dir, proxy: false });
    const config = await runConfigHook(plugin, dir, {
      command: "serve",
      mode: "development",
      isPreview: false,
    });

    expect(config?.server?.proxy).toBeUndefined();
    expect(config?.preview?.proxy).toBeUndefined();
  });
});

describe("windmill plugin – build mode", () => {
  it("uses the Windmill app path as base so asset URLs resolve correctly inside the iframe", async () => {
    const workspaceDir = await createTempWorkspace();
    const dir = await createMinimalRawApp(workspaceDir);

    setWindmillEnv();

    const plugin = windmill({ dir });
    const config = await runConfigHook(plugin, dir, {
      command: "build",
      mode: "production",
      isPreview: false,
    });

    // The app path for f/app/test.raw_app relative to workspaceDir is f/app/test
    // The base should be /apps_raw/get/f/app/test/
    expect(config?.base).toBe("/apps_raw/get/f/app/test/");
  });

  it("uses explicit base option when provided", async () => {
    const workspaceDir = await createTempWorkspace();
    const dir = await createMinimalRawApp(workspaceDir);

    setWindmillEnv();

    const plugin = windmill({ dir, base: "/apps_raw/get/custom/path/" });
    const config = await runConfigHook(plugin, dir, {
      command: "build",
      mode: "production",
      isPreview: false,
    });

    expect(config?.base).toBe("/apps_raw/get/custom/path/");
  });

  it("does not set publicDir in build mode", async () => {
    const workspaceDir = await createTempWorkspace();
    const dir = await createMinimalRawApp(workspaceDir);

    setWindmillEnv();

    const plugin = windmill({ dir });
    const config = await runConfigHook(plugin, dir, {
      command: "build",
      mode: "production",
      isPreview: false,
    });

    // publicDir should not be present (false) in build mode - Vite handles it
    expect(config?.publicDir).toBeUndefined();
  });

  it("runs a dry-run deploy after build when deploy: true is set", async () => {
    const workspaceDir = await createTempWorkspace();
    const dir = await createMinimalRawApp(workspaceDir);
    const messages: string[] = [];

    setWindmillEnv();

    const plugin = windmill({ deploy: { dry: true }, dir });
    await runConfigHook(plugin, dir, {
      command: "build",
      mode: "production",
      isPreview: false,
    });

    if (!plugin.writeBundle || typeof plugin.writeBundle !== "function")
      throw new Error("writeBundle hook missing");

    await plugin.writeBundle.call(
      createInfoPluginContext(messages),
      createOutputOptions(),
      createTestBundle(),
    );

    expect(messages).toContain("Windmill deploy dry-run ready for f/app/test");
  });

  it("enables deploy from WM_DEPLOY=dry when plugin deploy is unset", async () => {
    const workspaceDir = await createTempWorkspace();
    const dir = await createMinimalRawApp(workspaceDir);
    const messages: string[] = [];

    setWindmillEnv();
    process.env.WM_DEPLOY = "dry";

    const plugin = windmill({ dir });
    await runConfigHook(plugin, dir, {
      command: "build",
      mode: "production",
      isPreview: false,
    });

    if (!plugin.writeBundle || typeof plugin.writeBundle !== "function")
      throw new Error("writeBundle hook missing");

    await plugin.writeBundle.call(
      createInfoPluginContext(messages),
      createOutputOptions(),
      createTestBundle(),
    );

    expect(messages).toContain("Windmill deploy dry-run ready for f/app/test");
  });

  it("lets explicit deploy: false override WM_DEPLOY", async () => {
    const workspaceDir = await createTempWorkspace();
    const dir = await createMinimalRawApp(workspaceDir);
    const messages: string[] = [];

    setWindmillEnv();
    process.env.WM_DEPLOY = "dry";

    const plugin = windmill({ deploy: false, dir });
    await runConfigHook(plugin, dir, {
      command: "build",
      mode: "production",
      isPreview: false,
    });

    if (!plugin.writeBundle || typeof plugin.writeBundle !== "function")
      throw new Error("writeBundle hook missing");

    await plugin.writeBundle.call(
      createInfoPluginContext(messages),
      createOutputOptions(),
      createTestBundle(),
    );

    expect(messages).not.toContain("Windmill deploy dry-run ready for f/app/test");
  });

  it("rejects invalid WM_DEPLOY values during config resolution", async () => {
    const workspaceDir = await createTempWorkspace();
    const dir = await createMinimalRawApp(workspaceDir);

    setWindmillEnv();
    process.env.WM_DEPLOY = "banana";

    const plugin = windmill({ dir });

    await expect(
      runConfigHook(plugin, dir, {
        command: "build",
        mode: "production",
        isPreview: false,
      }),
    ).rejects.toThrow("Invalid WM_DEPLOY value `banana`");
  });

  it("surfaces generic missing-connection guidance during deploy", async () => {
    const workspaceDir = await createTempWorkspace();
    const dir = await createMinimalRawApp(workspaceDir);

    delete process.env.WM_WORKSPACE;
    process.env.WM_TOKEN = TEST_TOKEN;
    process.env.BASE_INTERNAL_URL = TEST_BASE_URL;

    const plugin = windmill({ deploy: { dry: true }, dir });
    await runConfigHook(plugin, dir, {
      command: "build",
      mode: "production",
      isPreview: false,
    });

    if (!plugin.writeBundle || typeof plugin.writeBundle !== "function")
      throw new Error("writeBundle hook missing");

    await expect(
      plugin.writeBundle.call(
        createInfoPluginContext([]),
        createOutputOptions(),
        createTestBundle(),
      ),
    ).rejects.toThrow("Missing Windmill workspace. Set `workspace` or `WM_WORKSPACE`.");
  });
});

describe("windmill plugin – metadata", () => {
  it("has the correct plugin name", () => {
    const plugin = windmill();
    expect(plugin.name).toBe("vite-plugin-windmill");
  });

  it("resolves the virtual wmill module in both serve and build mode", async () => {
    const plugin = windmill();
    if (!plugin.resolveId || typeof plugin.resolveId !== "function")
      throw new Error("resolveId hook missing");

    const resolved = await plugin.resolveId.call(createPluginContext(), "wmill", undefined, {
      isEntry: false,
      ssr: false,
    });

    expect(resolved).toBe(RESOLVED_VIRTUAL_WMILL_ID);
  });

  it("returns dev runtime source for serve mode and build runtime for build mode", async () => {
    const workspaceDir = await createTempWorkspace();
    const dir = await createMinimalRawApp(workspaceDir);

    const servePlugin = windmill({ dir });
    const buildPlugin = windmill({ dir });

    if (!servePlugin.load || typeof servePlugin.load !== "function")
      throw new Error("load hook missing");
    if (!buildPlugin.load || typeof buildPlugin.load !== "function")
      throw new Error("load hook missing");

    await runConfigHook(servePlugin, dir, {
      command: "serve",
      mode: "development",
      isPreview: false,
    });
    await runConfigHook(buildPlugin, dir, {
      command: "build",
      mode: "production",
      isPreview: false,
    });

    const serveSource = await servePlugin.load.call(
      createPluginContext(),
      RESOLVED_VIRTUAL_WMILL_ID,
    );
    expect(serveSource).toContain("/__windmill__/backend");
    expect(serveSource).not.toContain("parent.postMessage");

    const buildSource = await buildPlugin.load.call(
      createPluginContext(),
      RESOLVED_VIRTUAL_WMILL_ID,
    );
    expect(buildSource).toContain("parent.postMessage");
  });
});
