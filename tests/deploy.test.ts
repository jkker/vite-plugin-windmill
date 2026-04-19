import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type CreateOrUpdateAppArgs = { formData: unknown; path?: string; workspace: string };
type ExistingApp = { raw_app?: unknown };
type LookupAppArgs = { path: string; workspace: string };

const getAppByPath = vi.fn<(args: LookupAppArgs) => Promise<ExistingApp>>();
const createAppRaw = vi.fn<(args: CreateOrUpdateAppArgs) => Promise<void>>();
const updateAppRaw = vi.fn<(args: CreateOrUpdateAppArgs) => Promise<void>>();
const setClient = vi.fn<(token: string, url: string) => void>();

class MockApiError extends Error {
  readonly body: unknown;
  readonly request: unknown;
  readonly status: number;
  readonly statusText: string;
  readonly url: string;

  constructor(
    request: unknown,
    response: { body: unknown; status: number; statusText: string; url: string },
    message: string,
  ) {
    super(message);
    this.body = response.body;
    this.request = request;
    this.status = response.status;
    this.statusText = response.statusText;
    this.url = response.url;
  }
}

vi.mock("windmill-client", () => ({
  ApiError: MockApiError,
  AppService: {
    createAppRaw,
    getAppByPath,
    updateAppRaw,
  },
  setClient,
}));

const { deploy } = await import("../src/deploy.ts");

const tempDirs: string[] = [];

const originalEnv = {
  BASE_INTERNAL_URL: process.env.BASE_INTERNAL_URL,
  GITHUB_SHA: process.env.GITHUB_SHA,
  WM_TOKEN: process.env.WM_TOKEN,
  WM_WORKSPACE: process.env.WM_WORKSPACE,
};

const createTempWorkspace = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vite-plugin-windmill-"));
  tempDirs.push(dir);
  return dir;
};

const createRawApp = async (workspaceDir: string) => {
  const dir = path.join(workspaceDir, "f", "apps", "demo.raw_app");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(workspaceDir, "wmill.yaml"), "defaultTs: bun\n");
  await writeFile(path.join(dir, "raw_app.yaml"), "summary: Demo\n");
  await writeFile(path.join(dir, "index.tsx"), "export {}\n");
  return dir;
};

beforeEach(() => {
  process.env.WM_WORKSPACE = "example-workspace";
  process.env.WM_TOKEN = "example-token";
  process.env.BASE_INTERNAL_URL = "https://windmill.example.com";
  delete process.env.GITHUB_SHA;

  createAppRaw.mockReset();
  getAppByPath.mockReset();
  setClient.mockReset();
  updateAppRaw.mockReset();
});

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await import("node:fs/promises").then(async ({ rm }) =>
        rm(dir, { force: true, recursive: true }),
      );
    }),
  );

  if (originalEnv.BASE_INTERNAL_URL === undefined) delete process.env.BASE_INTERNAL_URL;
  else process.env.BASE_INTERNAL_URL = originalEnv.BASE_INTERNAL_URL;

  if (originalEnv.GITHUB_SHA === undefined) delete process.env.GITHUB_SHA;
  else process.env.GITHUB_SHA = originalEnv.GITHUB_SHA;

  if (originalEnv.WM_TOKEN === undefined) delete process.env.WM_TOKEN;
  else process.env.WM_TOKEN = originalEnv.WM_TOKEN;

  if (originalEnv.WM_WORKSPACE === undefined) delete process.env.WM_WORKSPACE;
  else process.env.WM_WORKSPACE = originalEnv.WM_WORKSPACE;
});

describe("deploy", () => {
  it("returns a dry-run result without contacting Windmill", async () => {
    const workspaceDir = await createTempWorkspace();
    const dir = await createRawApp(workspaceDir);

    const result = await deploy({
      bundles: { css: "body{}", js: 'console.log("demo")' },
      dir,
      dry: true,
    });

    expect(result).toEqual({
      action: "dry-run",
      base: "/apps_raw/get/f/apps/demo/",
      path: "f/apps/demo",
      workspace: "example-workspace",
    });
    expect(setClient).not.toHaveBeenCalled();
    expect(getAppByPath).not.toHaveBeenCalled();
  });

  it("creates a raw app when the remote app does not exist", async () => {
    const workspaceDir = await createTempWorkspace();
    const dir = await createRawApp(workspaceDir);

    getAppByPath.mockRejectedValueOnce(
      new MockApiError(
        { method: "GET" },
        { body: {}, status: 404, statusText: "Not Found", url: "https://windmill.example.com" },
        "Not Found",
      ),
    );

    const result = await deploy({
      bundles: { css: "body{}", js: 'console.log("demo")' },
      dir,
      message: "release",
    });

    expect(result.action).toBe("create");
    expect(setClient).toHaveBeenCalledWith("example-token", "https://windmill.example.com");
    expect(createAppRaw).toHaveBeenCalledOnce();
    expect(updateAppRaw).not.toHaveBeenCalled();
  });

  it("updates an existing raw app", async () => {
    const workspaceDir = await createTempWorkspace();
    const dir = await createRawApp(workspaceDir);

    getAppByPath.mockResolvedValueOnce({ raw_app: { path: "f/apps/demo" } });

    const result = await deploy({
      bundles: { css: "body{}", js: 'console.log("demo")' },
      dir,
    });

    expect(result.action).toBe("update");
    expect(updateAppRaw).toHaveBeenCalledOnce();
    expect(createAppRaw).not.toHaveBeenCalled();
  });

  it("uses a default deployment message when none is provided", async () => {
    const workspaceDir = await createTempWorkspace();
    const dir = await createRawApp(workspaceDir);

    getAppByPath.mockRejectedValueOnce(
      new MockApiError(
        { method: "GET" },
        { body: {}, status: 404, statusText: "Not Found", url: "https://windmill.example.com" },
        "Not Found",
      ),
    );

    await deploy({
      bundles: { css: "body{}", js: 'console.log("demo")' },
      dir,
    });

    expect(createAppRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        formData: expect.objectContaining({
          app: expect.objectContaining({
            deployment_message: "vite-plugin-windmill deploy",
          }),
        }),
      }),
    );
  });

  it("includes the GitHub SHA in the default deployment message when available", async () => {
    const workspaceDir = await createTempWorkspace();
    const dir = await createRawApp(workspaceDir);

    process.env.GITHUB_SHA = "240ce7d739a39a3f408f006e76e73bab2627c883";

    getAppByPath.mockRejectedValueOnce(
      new MockApiError(
        { method: "GET" },
        { body: {}, status: 404, statusText: "Not Found", url: "https://windmill.example.com" },
        "Not Found",
      ),
    );

    await deploy({
      bundles: { css: "body{}", js: 'console.log("demo")' },
      dir,
    });

    expect(createAppRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        formData: expect.objectContaining({
          app: expect.objectContaining({
            deployment_message:
              "vite-plugin-windmill deploy 240ce7d739a39a3f408f006e76e73bab2627c883",
          }),
        }),
      }),
    );
  });

  it("rejects non-404 lookup failures instead of treating them as missing apps", async () => {
    const workspaceDir = await createTempWorkspace();
    const dir = await createRawApp(workspaceDir);

    getAppByPath.mockRejectedValueOnce(
      new MockApiError(
        { method: "GET" },
        {
          body: { error: "unauthorized" },
          status: 401,
          statusText: "Unauthorized",
          url: "https://windmill.example.com",
        },
        "Unauthorized",
      ),
    );

    await expect(
      deploy({
        bundles: { css: "body{}", js: 'console.log("demo")' },
        dir,
      }),
    ).rejects.toThrow("Unauthorized");

    expect(createAppRaw).not.toHaveBeenCalled();
    expect(updateAppRaw).not.toHaveBeenCalled();
  });
});
