import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vite-plus/test";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const packageDir = path.resolve(import.meta.dirname, "..");

const createTempDir = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const writeFakeVitePackage = async (parentDir: string): Promise<string> => {
  const viteDir = path.join(parentDir, "fake-vite");
  await mkdir(viteDir, { recursive: true });
  await writeFile(
    path.join(viteDir, "package.json"),
    JSON.stringify(
      {
        name: "vite",
        private: true,
        type: "module",
        version: "0.0.0-test",
        exports: {
          ".": "./index.js",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(path.join(viteDir, "index.js"), "export const loadEnv = () => ({})\n");
  return viteDir;
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

describe("published package smoke test", () => {
  it("packs to a dist-only manifest and installs cleanly for an external consumer", async () => {
    const packDir = await createTempDir("vite-plugin-windmill-pack-");
    const consumerDir = await createTempDir("vite-plugin-windmill-consumer-");
    const fakeViteDir = await writeFakeVitePackage(consumerDir);

    await execFileAsync("pnpm", ["--dir", packageDir, "build"]);
    await execFileAsync("pnpm", ["--dir", packageDir, "pack", "--pack-destination", packDir]);

    const tarballName = (await import("node:fs/promises"))
      .readdir(packDir)
      .then((entries) => entries.find((entry) => entry.endsWith(".tgz")));
    const tarballPath = path.join(packDir, await tarballName.then((entry) => entry ?? ""));
    if (!tarballPath.endsWith(".tgz")) throw new Error("Expected packed tarball to exist");

    await writeFile(
      path.join(consumerDir, "package.json"),
      JSON.stringify({ name: "consumer-smoke", private: true, type: "module" }, null, 2),
    );

    await execFileAsync("pnpm", [
      "add",
      fakeViteDir,
      tarballPath,
      "--dir",
      consumerDir,
      "--ignore-scripts",
    ]);

    const installedPackageJson = JSON.parse(
      await readFile(
        path.join(consumerDir, "node_modules", "vite-plugin-windmill", "package.json"),
        "utf8",
      ),
    ) as {
      exports: Record<string, unknown>;
      files?: string[];
      publishConfig?: { provenance?: boolean };
    };

    expect(installedPackageJson.exports).toEqual({
      ".": "./dist/index.mjs",
      "./package.json": "./package.json",
    });
    expect(installedPackageJson.files).toEqual(["dist", "bin"]);
    expect(installedPackageJson.publishConfig?.provenance).toBe(true);

    const importResult = await execFileAsync(
      "node",
      [
        "--input-type=module",
        "-e",
        'import windmill,{deploy} from "vite-plugin-windmill"; console.log(typeof windmill, typeof deploy)',
      ],
      { cwd: consumerDir },
    );
    expect(importResult.stdout.trim()).toBe("function function");

    const cliResult = await execFileAsync("pnpm", ["exec", "vite-plugin-windmill", "--help"], {
      cwd: consumerDir,
    });
    expect(cliResult.stdout).toContain("Deploy a built Windmill raw app bundle.");
  });
});
