# vite-plugin-windmill

Vite plugin and deploy tooling for Windmill raw apps.

## Features

- infers a Windmill raw-app path and `base` from a `.raw_app` or `__raw_app` directory
- injects a virtual `wmill` runtime for local dev and production builds
- configures authenticated `/api` proxying for Vite dev and preview when a Windmill URL and token are available
- assembles raw-app payloads from `raw_app.yaml`, `backend/`, and tracked app files
- honors repo `wmill.yaml` exclude globs when collecting app files for deploy
- optionally deploys the built raw app after `vite build`

## Versioning

This package version tracks Windmill minor releases. New package versions are published for new Windmill minor lines; patch releases within a line are absorbed by the `windmill-client` range and the pinned generated runtime source.

<!-- windmill-release:compat-start -->

Current release line: `1.684.x`

It currently depends on `windmill-client@^1.684.0` and bundles `rawAppWmillTs.ts` generated from `windmill-labs/windmill@v1.684.1`.

<!-- windmill-release:compat-end -->

Install the release line that matches your Windmill minor version:

```bash
pnpm add -D vite-plugin-windmill@1.687.0
pnpm add -D vite-plugin-windmill@1.686.0
pnpm add -D vite-plugin-windmill@1.685.0
```

Backfilled historical lines are published as `1.<windmill-minor>.0`. For example, a workspace on Windmill `1.684.1` should install `vite-plugin-windmill@1.684.0`.

## Install

```bash
pnpm add -D vite vite-plugin-windmill
npm install --save-dev vite vite-plugin-windmill
bun add -d vite vite-plugin-windmill
```

`vite` is a peer dependency. `windmill-client` and `yaml` are bundled runtime dependencies. The package currently targets Node.js 22+.

## Usage

```ts
import { defineConfig } from "vite";
import windmill from "vite-plugin-windmill";

export default defineConfig({
  plugins: [windmill({ entry: "src/main.tsx" })],
});
```

Expected project shape:

```text
f/example/app.raw_app/
  raw_app.yaml
  index.tsx
  backend/
    hello.py
    hello.yaml
```

The plugin resolves the raw-app directory from `dir` or by searching upward for `raw_app.yaml`. It infers the Windmill app path from the raw-app folder name, so `f/example/app.raw_app` becomes `f/example/app`.

## Environment Variables

The plugin and CLI resolve connection settings in this order:

- `WM_WORKSPACE`: Windmill workspace name when `workspace` is not passed directly
- `WM_TOKEN`: API token used for authenticated proxying and deploys
- `BASE_INTERNAL_URL`: preferred Windmill base URL for local proxying and deploys
- `BASE_URL`: fallback Windmill base URL when `BASE_INTERNAL_URL` is unset
- `WM_DEPLOY`: optional deploy toggle for `vite build`; accepts `true`, `false`, `dry`, and `check`

## Options

`windmill(options)` accepts:

- `dir`: raw-app directory. Defaults to the nearest ancestor containing `raw_app.yaml`.
- `entry`: entry file relative to `dir`. Defaults to `index.ts` or `index.tsx`.
- `path`: override the inferred Windmill app path.
- `base`: override the inferred raw-app base URL.
- `root`: workspace root used for path inference and `wmill.yaml` discovery.
- `workspace`: Windmill workspace override.
- `token`: Windmill API token override.
- `url`: Windmill base URL override.
- `proxy`: `false` to disable proxying, or an object with `context`, `target`, `token`, and any Vite proxy options.
- `deploy`: `true`, `false`, or `{ dry?: boolean; message?: string }`.
- `nonDotted`: override `wmill.yaml` `nonDottedPaths`.
- `ts`: default TypeScript runnable language override.

Connection resolution order:

- `workspace`: plugin option `workspace`, then `WM_WORKSPACE`
- `token`: plugin option `token`, then `WM_TOKEN`
- `url`: plugin option `url`, then `BASE_INTERNAL_URL`, then `BASE_URL`

By default, the plugin adds a shared `/api` proxy for both `vite dev` and `vite preview` when it can resolve a Windmill URL and token from plugin options or from `BASE_INTERNAL_URL` or `BASE_URL` plus `WM_TOKEN`.

Use `proxy: false` to disable it, or pass overrides such as `proxy: { context: '/wm-api', target: 'https://windmill.internal', token: process.env.WM_TOKEN }`.

## Quick Start

```ts
import { defineConfig } from "vite";
import windmill from "vite-plugin-windmill";

export default defineConfig({
  plugins: [
    windmill({
      dir: "f/example/app.raw_app",
      entry: "index.tsx",
    }),
  ],
});
```

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "deploy": "WM_DEPLOY=true vite build"
  }
}
```

## Deploy After Build

The plugin can deploy the built raw-app bundle after `vite build`.

```ts
windmill({
  deploy: true,
  entry: "src/main.tsx",
});
```

`deploy` also accepts an options object:

```ts
windmill({
  deploy: {
    dry: true,
    message: "preview release",
  },
});
```

Behavior:

- `deploy: true`: deploy after build
- `deploy: { dry: true }`: validate the local deploy payload without contacting or mutating Windmill
- `deploy: { message: '...' }`: override the deployment message sent to Windmill
- explicit `deploy` config wins over `WM_DEPLOY`

If you prefer environment-driven deploys, leave `deploy` unset and use `WM_DEPLOY`:

```bash
WM_DEPLOY=true vite build
WM_DEPLOY=dry vite build
```

Accepted `WM_DEPLOY` values:

- truthy: `true`, `1`, `yes`, `on`, empty string
- falsy: `false`, `0`, `no`, `off`
- dry-run: `dry`, `check`

## Deploy CLI

The package also exposes a deploy CLI:

```bash
vite-plugin-windmill --dir ./f/example/app.raw_app --dry
vite-plugin-windmill --dir ./f/example/app.raw_app --message "manual deploy"
vite-plugin-windmill --dir ./f/example/app.raw_app --js ./dist/assets/index.js --css ./dist/assets/index.css
```

Use `vite-plugin-windmill --help` for all flags.

## Programmatic Deploy

You can also deploy outside the Vite plugin lifecycle:

```ts
import { deploy } from "vite-plugin-windmill";

await deploy({
  dir: "./f/example/app.raw_app",
  dry: true,
  workspace: process.env.WM_WORKSPACE,
  token: process.env.WM_TOKEN,
  url: process.env.BASE_URL,
});
```

`deploy()` resolves the same raw-app metadata as the plugin and accepts optional `bundles`, `js`, and `css` overrides when you want to supply build artifacts explicitly.

## Release Integrity

Release tags are created in GitHub Actions and published to npm through npm Trusted Publisher. That gives newly published versions registry-backed provenance attestations without storing an npm automation token in GitHub.

The initial bootstrap publish of `1.687.0` happened before the Trusted Publisher workflow was active, so it does not carry npm provenance. Older backfilled versions and future releases are published from CI.

## Example Scripts

```json
{
  "scripts": {
    "bundle": "vite build",
    "deploy": "WM_DEPLOY=\"${WM_DEPLOY:-true}\" vite build"
  }
}
```
