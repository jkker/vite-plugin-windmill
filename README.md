# vite-plugin-windmill

Vite plugin and deploy tooling for Windmill raw apps.

## Features

- infers a Windmill raw-app path and `base` from a `.raw_app` or `__raw_app` directory
- injects a virtual `wmill` runtime for local dev and production builds
- configures authenticated `/api` proxying for Vite dev and preview when a Windmill URL and token are available
- assembles raw-app payloads from `raw_app.yaml`, `backend/`, and tracked app files
- honors repo `wmill.yaml` exclude globs when collecting app files for deploy
- optionally deploys the built raw app after `vite build`

## Install

```bash
pnpm add -D vite vite-plugin-windmill
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

## Example Scripts

```json
{
  "scripts": {
    "bundle": "vite build",
    "deploy": "WM_DEPLOY=\"${WM_DEPLOY:-true}\" vite build"
  }
}
```
