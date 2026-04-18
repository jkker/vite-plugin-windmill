import path from "node:path";
import { Readable } from "node:stream";
import { scheduler } from "node:timers/promises";

import type { Plugin, Connect, ProxyOptions } from "vite";
import { loadEnv } from "vite";
import type { OutputBundle } from "vite/rolldown";
import { AppService, JobService, setClient, type ExecuteComponentData } from "windmill-client";

import { deploy } from "./deploy.ts";
import {
  WMILL_IMPORT_PATTERN,
  loadRawAppProject,
  resolveProject,
  writeGeneratedWmillTypes,
} from "./project.ts";
import { getWindmillRuntimeSource } from "./runtime.ts";
import type {
  PluginDeployOptions,
  PluginOptions,
  Project,
  RawAppRunnable,
  WindmillApiProxyOptions,
} from "./types.ts";
const VIRTUAL_WMILL_ID = "virtual:vite-plugin-windmill/wmill";
const RESOLVED_VIRTUAL_WMILL_ID = `\0${VIRTUAL_WMILL_ID}`;
const DEFAULT_BUILD_OUT_DIR = "dist/windmill";
const DEFAULT_API_PROXY_CONTEXT = "/api";
const DEPLOY_TRUE_VALUES = new Set(["", "1", "on", "true", "yes"]);
const DEPLOY_FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const DEPLOY_DRY_VALUES = new Set(["check", "dry"]);

const normalizePath = (value: string): string => value.split(path.sep).join("/");

const buildHtmlDocument = (entryFile: string): string => {
  const entryPath = normalizePath(entryFile.startsWith("/") ? entryFile : `/${entryFile}`);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Windmill Dev</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@vite/client"></script>
    <script type="module" src="${entryPath}"></script>
  </body>
</html>`;
};

const toErrorMessage = (value: unknown): string => {
  if (value instanceof Error) return value.message;

  if (typeof value === "string") return value;

  try {
    return JSON.stringify(value);
  } catch {
    return "Unknown error";
  }
};

const requireString = (value: unknown, fieldName: string): string => {
  if (typeof value === "string" && value.length > 0) return value;

  if (typeof value === "number" && Number.isFinite(value)) return String(value);

  throw new Error(`Missing or invalid ${fieldName}`);
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

const readJsonBody = async (request: NodeJS.ReadableStream): Promise<Record<string, unknown>> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request)
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);

  if (chunks.length === 0) return {};

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
};

const waitForJobResult = async (workspace: string, jobId: string): Promise<unknown> => {
  let delay = 50;
  for (;;) {
    const result = await JobService.getCompletedJobResultMaybe({
      workspace,
      id: jobId,
      getStarted: false,
    });

    if (result.completed) {
      if (
        !result.success &&
        typeof result.result === "object" &&
        result.result &&
        "error" in result.result
      )
        throw new Error(toErrorMessage((result.result as { error?: unknown }).error));

      return result.result;
    }

    await scheduler.wait(delay);
    delay = delay >= 500 ? 2_000 : 500;
  }
};

const executeRunnable = async (
  project: Project,
  workspace: string,
  runnableId: string,
  runnable: RawAppRunnable,
  args: unknown,
): Promise<string> => {
  const requestBody: ExecuteComponentData["requestBody"] = {
    args: (args ?? {}) as Record<string, unknown>,
    component: runnableId,
    force_viewer_allow_user_resources: Object.entries(runnable.fields ?? {})
      .filter(([, field]) => field.allowUserResources)
      .map(([name]) => name),
    force_viewer_one_of_fields: {},
    force_viewer_static_fields: Object.fromEntries(
      Object.entries(runnable.fields ?? {})
        .filter(([, field]) => field.type === "static")
        .map(([name, field]) => [name, field.value]),
    ),
  };

  if (runnable.inlineScript) {
    requestBody.raw_code = {
      cache_ttl: runnable.inlineScript.cache_ttl,
      content: runnable.inlineScript.id === undefined ? (runnable.inlineScript.content ?? "") : "",
      language: runnable.inlineScript.language ?? "",
      lock: runnable.inlineScript.id === undefined ? runnable.inlineScript.lock : undefined,
      path: `${project.path}/${runnableId}`,
    };
    if (runnable.inlineScript.id !== undefined) requestBody.id = runnable.inlineScript.id;
  } else if (runnable.path && runnable.runType)
    requestBody.path = `${runnable.runType === "hubscript" ? "script" : runnable.runType}/${runnable.path}`;
  else throw new Error(`Runnable ${runnableId} is missing inline or path metadata`);

  return AppService.executeComponent({
    workspace,
    path: project.path,
    requestBody,
  });
};

const extractBundleContents = (bundle: OutputBundle) => {
  let css = "";
  let js = "";

  for (const output of Object.values(bundle)) {
    if (output.type === "chunk" && output.fileName === "bundle.js") js = output.code;

    if (output.type === "asset" && output.fileName === "bundle.css") {
      css =
        typeof output.source === "string"
          ? output.source
          : Buffer.from(output.source).toString("utf8");
    }
  }

  return { css, js };
};

const hasAuthorizationHeader = (headers: ProxyOptions["headers"]): boolean =>
  Object.keys(headers ?? {}).some((key) => key.toLowerCase() === "authorization");

const resolveApiProxyConfig = (
  project: Project,
  proxy: PluginOptions["proxy"],
): Record<string, ProxyOptions> | undefined => {
  if (proxy === false) return undefined;

  const proxyOptions =
    proxy && typeof proxy === "object" ? ({ ...proxy } as WindmillApiProxyOptions) : undefined;
  const enabled = typeof proxy === "object" ? (proxy.enabled ?? true) : (proxy ?? true);
  if (!enabled) return undefined;

  const context = proxyOptions?.context ?? DEFAULT_API_PROXY_CONTEXT;
  const target = proxyOptions?.target ?? project.url;
  if (!target) return undefined;

  const {
    context: _context,
    enabled: _enabled,
    target: _target,
    token,
    ...rest
  } = proxyOptions ?? {};
  const headers = { ...rest.headers };
  const resolvedToken = token ?? project.token;
  if (!hasAuthorizationHeader(headers) && resolvedToken)
    headers.Authorization = `Bearer ${resolvedToken}`;

  return {
    [context]: {
      changeOrigin: rest.changeOrigin ?? true,
      ...rest,
      headers,
      target,
    },
  };
};

const resolveProjectFromViteConfig = async (
  options: PluginOptions,
  root: string | undefined,
  mode: string,
): Promise<Project> => {
  const env = loadEnv(mode, root ?? process.cwd(), "");

  return resolveProject({
    ...options,
    dir: root ?? options.dir,
    token: options.token ?? env.WM_TOKEN ?? process.env.WM_TOKEN,
    url:
      options.url ??
      env.BASE_INTERNAL_URL ??
      env.BASE_URL ??
      process.env.BASE_INTERNAL_URL ??
      process.env.BASE_URL,
    workspace: options.workspace ?? env.WM_WORKSPACE ?? process.env.WM_WORKSPACE,
  });
};

const normalizeDeployOptions = (
  deployOptions: PluginOptions["deploy"],
): PluginDeployOptions | undefined => {
  if (typeof deployOptions === "boolean") return { deploy: deployOptions };
  if (!deployOptions) return undefined;

  return {
    deploy: deployOptions.deploy ?? true,
    dry: deployOptions.dry,
    message: deployOptions.message,
  };
};

const parseDeployEnv = (value: string | undefined): PluginDeployOptions | undefined => {
  if (value === undefined) return undefined;

  const normalized = value.trim().toLowerCase();
  if (normalized === "undefined" || normalized === "null") return undefined;
  if (DEPLOY_TRUE_VALUES.has(normalized)) return { deploy: true };
  if (DEPLOY_FALSE_VALUES.has(normalized)) return { deploy: false };
  if (DEPLOY_DRY_VALUES.has(normalized)) return { deploy: true, dry: true };

  throw new Error(`Invalid WM_DEPLOY value \`${value}\`. Expected boolean-like values or \`dry\`.`);
};

const resolveDeployOptions = (
  options: PluginOptions,
  root: string | undefined,
  mode: string,
): PluginDeployOptions => {
  const explicitDeploy = normalizeDeployOptions(options.deploy);
  if (explicitDeploy) return explicitDeploy;

  const env = loadEnv(mode, root ?? process.cwd(), "");
  return parseDeployEnv(env.WM_DEPLOY ?? process.env.WM_DEPLOY) ?? { deploy: false };
};

/**
 * Generates the HTML host shell for `vite preview`. It embeds the production IIFE bundle
 * in a same-origin blob-URL iframe, mirroring how Windmill renders raw apps, and relays
 * postMessage backend requests to the local /__windmill__/ HTTP proxy.
 */
const buildPreviewHostShellHtml = (workspace: string): string => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Windmill Preview</title>
  <style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}iframe{position:fixed;inset:0;width:100%;height:100%;border:none}</style>
</head>
<body>
  <iframe id="app" title="raw-app" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals allow-pointer-lock allow-presentation allow-storage-access-by-user-activation allow-top-navigation-by-user-activation"></iframe>
  <script type="module">
    window.localStorage.setItem('workspace', ${JSON.stringify(workspace)})

    window.addEventListener('message', async ({ data: msg }) => {
      if (!msg?.type || !msg?.reqId) return
      const { type, reqId } = msg
      const frame = document.getElementById('app')
      const send = (result, error) =>
        frame.contentWindow?.postMessage({ type: type + 'Res', reqId, result, error: !!error }, '*')

      try {
        if (type === 'backend' || type === 'backendAsync') {
          const ep = type === 'backend' ? '/__windmill__/backend' : '/__windmill__/backend-async'
          const r = await fetch(ep, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ runnableId: msg.runnable_id, args: msg.v ?? {} }),
          })
          const p = await r.json()
          send(p.result, !!p.error)
        } else if (type === 'waitJob') {
          const r = await fetch('/__windmill__/wait-job', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jobId: msg.jobId }),
          })
          const p = await r.json()
          send(p.result, !!p.error)
        } else if (type === 'getJob') {
          const r = await fetch('/__windmill__/get-job', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jobId: msg.jobId }),
          })
          const p = await r.json()
          send(p.result, !!p.error)
        } else if (type === 'streamJob') {
          const source = new EventSource('/__windmill__/stream-job/' + encodeURIComponent(msg.jobId))
          source.addEventListener('update', (e) =>
            frame.contentWindow?.postMessage({ type: 'streamJobUpdate', reqId, ...JSON.parse(e.data) }, '*'))
          source.addEventListener('done', (e) => { source.close(); send(JSON.parse(e.data), false) })
          source.addEventListener('error', () => { source.close(); send({ message: 'Stream error' }, true) })
        }
      } catch (err) {
        send({ message: err?.message ?? String(err) }, true)
      }
    })

    // Fetch the production bundle, wrap it in a blob URL, and load it into the iframe.
    // Using a blob URL makes window.location.protocol === 'blob:' inside the iframe,
    // which matches the production Windmill embedding behaviour.
    const [cssRes, jsRes] = await Promise.all([fetch('/bundle.css'), fetch('/bundle.js')])
    const [css, js] = await Promise.all([cssRes.text(), jsRes.text()])
    const html = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">'
      + (css ? '<style>' + css + '</style>' : '')
      + '</head><body><div id="root"></div><script>'
      + js + '<\\/script></body></html>'
    document.getElementById('app').src = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  </script>
</body>
</html>`;

/**
 * Creates a Vite plugin that aligns a SPA with Windmill raw-app build and deploy behavior.
 */
const windmill = (options: PluginOptions = {}): Plugin => {
  let project: Project | undefined;
  let command: "build" | "serve" = "serve";
  let deployOptions: PluginDeployOptions = { deploy: false };

  /**
   * Shared Connect middleware that handles all /__windmill__/ API routes.
   * Used by both the dev server and the preview server.
   */
  const windmillApiHandler: Connect.NextHandleFunction = async (request, response, next) => {
    try {
      if (!project) return next();

      const sendJson = (payload: unknown) => response.end(JSON.stringify(payload));

      const connection = requireProjectConnection(project);
      setClient(connection.token, connection.url);

      if (request.url === "/__windmill__/backend" && request.method === "POST") {
        try {
          const body = await readJsonBody(request);
          const rawAppProject = await loadRawAppProject(project);
          const runnableId = requireString(body.runnableId, "runnableId");
          const runnable = rawAppProject.runnables[runnableId];
          if (!runnable) throw new Error(`Runnable not found: ${runnableId}`);

          const jobId = await executeRunnable(
            project,
            connection.workspace,
            runnableId,
            runnable,
            body.args,
          );
          const result = await waitForJobResult(connection.workspace, jobId);
          response.setHeader("content-type", "application/json");
          sendJson({ result });
        } catch (error) {
          response.statusCode = 500;
          response.setHeader("content-type", "application/json");
          sendJson({ error: toErrorMessage(error) });
        }
        return;
      }

      if (request.url === "/__windmill__/backend-async" && request.method === "POST") {
        try {
          const body = await readJsonBody(request);
          const rawAppProject = await loadRawAppProject(project);
          const runnableId = requireString(body.runnableId, "runnableId");
          const runnable = rawAppProject.runnables[runnableId];
          if (!runnable) throw new Error(`Runnable not found: ${runnableId}`);

          const jobId = await executeRunnable(
            project,
            connection.workspace,
            runnableId,
            runnable,
            body.args,
          );
          response.setHeader("content-type", "application/json");
          sendJson({ result: jobId });
        } catch (error) {
          response.statusCode = 500;
          response.setHeader("content-type", "application/json");
          sendJson({ error: toErrorMessage(error) });
        }
        return;
      }

      if (request.url === "/__windmill__/wait-job" && request.method === "POST") {
        try {
          const body = await readJsonBody(request);
          const result = await waitForJobResult(
            connection.workspace,
            requireString(body.jobId, "jobId"),
          );
          response.setHeader("content-type", "application/json");
          sendJson({ result });
        } catch (error) {
          response.statusCode = 500;
          response.setHeader("content-type", "application/json");
          sendJson({ error: toErrorMessage(error) });
        }
        return;
      }

      if (request.url === "/__windmill__/get-job" && request.method === "POST") {
        try {
          const body = await readJsonBody(request);
          const result = await JobService.getJob({
            workspace: connection.workspace,
            id: requireString(body.jobId, "jobId"),
          });
          response.setHeader("content-type", "application/json");
          sendJson({ result });
        } catch (error) {
          response.statusCode = 500;
          response.setHeader("content-type", "application/json");
          sendJson({ error: toErrorMessage(error) });
        }
        return;
      }

      if (request.url?.startsWith("/__windmill__/stream-job/") && request.method === "GET") {
        try {
          const jobId = decodeURIComponent(request.url.slice("/__windmill__/stream-job/".length));
          response.setHeader("cache-control", "no-cache");
          response.setHeader("content-type", "text/event-stream");
          response.setHeader("connection", "keep-alive");
          const sseResponse = await fetch(
            `${connection.url.replace(/\/$/, "")}/api/w/${connection.workspace}/jobs_u/getupdate_sse/${jobId}?fast=true`,
            {
              headers: {
                accept: "text/event-stream",
                authorization: `Bearer ${connection.token}`,
              },
            },
          );

          if (!sseResponse.ok || !sseResponse.body)
            throw new Error(`Failed to stream Windmill job ${jobId}`);

          const reader = Readable.fromWeb(sseResponse.body);
          let buffer = "";
          for await (const chunk of reader) {
            buffer += chunk.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;

              const payload = JSON.parse(line.slice("data: ".length)) as {
                completed?: boolean;
                error?: string;
                new_result_stream?: string;
                only_result?: unknown;
                stream_offset?: number;
                type?: string;
              };

              if (payload.type === "ping") continue;

              if (payload.type === "timeout") {
                response.write(`event: error\ndata: ${JSON.stringify("Stream timed out")}\n\n`);
                response.end();
                return;
              }

              if (payload.type === "error") {
                response.write(
                  `event: error\ndata: ${JSON.stringify(payload.error ?? "Stream error")}\n\n`,
                );
                response.end();
                return;
              }

              if (payload.new_result_stream !== undefined) {
                response.write(
                  `event: update\ndata: ${JSON.stringify({ new_result_stream: payload.new_result_stream, stream_offset: payload.stream_offset })}\n\n`,
                );
              }

              if (payload.completed) {
                response.write(`event: done\ndata: ${JSON.stringify(payload.only_result)}\n\n`);
                response.end();
                return;
              }
            }
          }

          response.end();
        } catch (error) {
          response.write(`event: error\ndata: ${JSON.stringify(toErrorMessage(error))}\n\n`);
          response.end();
        }
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  };

  return {
    name: "vite-plugin-windmill",
    async config(userConfig, env) {
      project = await resolveProjectFromViteConfig(options, userConfig.root, env.mode);
      command = env.command;
      deployOptions = resolveDeployOptions(options, userConfig.root, env.mode);

      const isServe = env.command === "serve";
      const apiProxy = resolveApiProxyConfig(project, options.proxy);

      return {
        appType: "custom",
        // In serve mode (dev + preview), use '/' so Vite's base middleware does not
        // intercept /__windmill__/ backend routes. The Windmill app base only matters
        // for the production IIFE bundle (asset URL resolution inside the iframe).
        base: isServe ? "/" : project.base,
        // Always set outDir so that `vite preview` serves from the same directory
        // that `vite build` writes to.
        build: {
          chunkSizeWarningLimit: 2_048,
          outDir: DEFAULT_BUILD_OUT_DIR,
          ...(isServe
            ? {}
            : {
                assetsInlineLimit: Number.MAX_SAFE_INTEGER,
                cssCodeSplit: false,
                modulePreload: false,
                reportCompressedSize: false,
                rolldownOptions: {
                  input: project.entry,
                  output: {
                    assetFileNames: (assetInfo) =>
                      assetInfo.name?.endsWith(".css")
                        ? "bundle.css"
                        : "assets/[name]-[hash][extname]",
                    entryFileNames: "bundle.js",
                    format: "iife",
                  },
                },
              }),
        },
        ...(isServe ? { publicDir: false } : {}),
        define: {
          "process.env.NODE_ENV": JSON.stringify(isServe ? "development" : "production"),
        },
        preview: {
          open: false,
          ...(apiProxy ? { proxy: apiProxy } : {}),
        },
        server: {
          open: false,
          ...(apiProxy ? { proxy: apiProxy } : {}),
        },
      };
    },
    async configResolved(resolvedConfig) {
      project = await resolveProjectFromViteConfig(
        options,
        resolvedConfig.root,
        resolvedConfig.mode,
      );
      deployOptions = resolveDeployOptions(options, resolvedConfig.root, resolvedConfig.mode);
      await writeGeneratedWmillTypes(project);
    },
    resolveId(id) {
      if (WMILL_IMPORT_PATTERN.test(id)) return RESOLVED_VIRTUAL_WMILL_ID;

      return undefined;
    },
    load(id) {
      if (id === RESOLVED_VIRTUAL_WMILL_ID) return getWindmillRuntimeSource(command);

      return undefined;
    },
    configurePreviewServer(previewServer) {
      return () => {
        // Serve the host shell HTML for any HTML GET that Vite's static middleware
        // did not handle (no index.html in the build output directory).
        const previewHandler: Connect.NextHandleFunction = async (request, response, next) => {
          if (!project) return next();

          const acceptsHtml = request.headers.accept?.includes("text/html") ?? false;
          const url = request.url ?? "/";
          if (
            request.method === "GET" &&
            !url.startsWith("/__windmill__/") &&
            (acceptsHtml || (!path.extname(url) && !url.includes("?")))
          ) {
            if (!project.workspace)
              throw new Error("Missing Windmill workspace. Set `workspace` or `WM_WORKSPACE`.");
            response.setHeader("content-type", "text/html");
            response.end(buildPreviewHostShellHtml(project.workspace));
            return;
          }

          // oxlint-disable-next-line promise/no-callback-in-promise
          return Promise.resolve(windmillApiHandler(request, response, next)).catch(next);
        };

        previewServer.middlewares.use((req, res, next) =>
          // oxlint-disable-next-line promise/no-callback-in-promise
          Promise.resolve(previewHandler(req, res, next)).catch(next),
        );
      };
    },
    configureServer(configuredServer) {
      return () => {
        const handler: Connect.NextHandleFunction = async (request, response, next) => {
          try {
            if (!project) return next();

            // Delegate all /__windmill__/ API requests to the shared handler.
            if (request.url?.startsWith("/__windmill__/")) {
              // oxlint-disable-next-line promise/no-callback-in-promise
              return Promise.resolve(windmillApiHandler(request, response, next)).catch(next);
            }

            // Serve the app HTML for all extensionless GET requests (SPA routing).
            // Do not gate on Accept: text/html — health-check tools and Playwright
            // webServer readiness probes send plain GET requests without that header.
            const url = request.url ?? "/";
            if (request.method === "GET" && !path.extname(url) && !url.includes("?")) {
              const entryRelative = normalizePath(path.relative(project.dir, project.entry));
              const html = await configuredServer.transformIndexHtml(
                url,
                buildHtmlDocument(entryRelative),
              );
              response.setHeader("content-type", "text/html");
              response.end(html);
              return;
            }

            next();
          } catch (error) {
            next(error);
          }
        };

        configuredServer.middlewares.use((req, res, next) =>
          // oxlint-disable-next-line promise/no-callback-in-promise
          Promise.resolve(handler(req, res, next)).catch(next),
        );
      };
    },
    async handleHotUpdate(context) {
      if (!project) return;

      if (
        context.file.startsWith(path.join(project.dir, "backend")) ||
        context.file === project.yaml
      ) {
        await writeGeneratedWmillTypes(project);
        context.server.ws.send({ type: "full-reload" });
        return;
      }
    },
    async writeBundle(_outputOptions, bundle) {
      if (!project) return;

      if (!deployOptions.deploy) return;

      const result = await deploy({
        base: project.base,
        bundles: extractBundleContents(bundle),
        dir: project.dir,
        dry: deployOptions.dry,
        message: deployOptions.message ?? options.message,
        path: project.path,
        root: project.root,
        token: project.token,
        url: project.url,
        workspace: project.workspace,
      });

      this.info(
        result.action === "dry-run"
          ? `Windmill deploy dry-run ready for ${result.path}`
          : `Windmill raw app ${result.action}d: ${result.path}`,
      );
    },
  };
};

export default windmill;
