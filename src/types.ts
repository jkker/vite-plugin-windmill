import type { ProxyOptions } from "vite";
import type { Policy } from "windmill-client";

export interface WindmillApiProxyOptions extends ProxyOptions {
  context?: string;
  enabled?: boolean;
  target?: string;
  token?: string;
}

export interface PluginDeployOptions {
  deploy?: boolean;
  dry?: boolean;
  message?: string;
}

export interface PluginOptions {
  base?: string;
  deploy?: boolean | PluginDeployOptions;
  dir?: string;
  entry?: string;
  message?: string;
  nonDotted?: boolean;
  path?: string;
  proxy?: boolean | WindmillApiProxyOptions;
  root?: string;
  token?: string;
  ts?: string;
  url?: string;
  workspace?: string;
}

export interface Project {
  base: string;
  config?: string;
  dir: string;
  entry: string;
  nonDotted: boolean;
  path: string;
  root: string;
  syncExcludes: string[];
  ts: string;
  workspace?: string;
  token?: string;
  url?: string;
  yaml: string;
}

export interface RawAppFileConfig {
  summary: string;
  custom_path?: string;
  public?: boolean;
  data?: unknown;
  policy?: Policy;
  runnables?: Record<string, RawAppRunnable>;
}

export interface RawAppField {
  allowUserResources?: boolean;
  ctx?: string;
  type?: string;
  value?: unknown;
  [key: string]: unknown;
}

export interface RawInlineScript {
  cache_ttl?: number;
  content?: string;
  id?: number;
  language?: string;
  lock?: string;
  schema?: unknown;
}

export interface RawAppRunnable {
  fields?: Record<string, RawAppField>;
  inlineScript?: RawInlineScript;
  path?: string;
  runType?: "flow" | "hubscript" | "script";
  schema?: unknown;
  type?: string;
  [key: string]: unknown;
}

export interface RawAppProject {
  config: RawAppFileConfig;
  files: Record<string, string>;
  policy: Policy;
  runnables: Record<string, RawAppRunnable>;
  value: {
    data?: unknown;
    files: Record<string, string>;
    runnables: Record<string, RawAppRunnable>;
  };
}

export interface BundleContents {
  css: string;
  js: string;
}

export interface DeployOptions {
  base?: string;
  bundles?: BundleContents;
  css?: string;
  dir?: string;
  dry?: boolean;
  entry?: string;
  js?: string;
  message?: string;
  path?: string;
  root?: string;
  token?: string;
  url?: string;
  workspace?: string;
}

export interface DeployRawAppResult {
  action: "create" | "dry-run" | "update";
  base: string;
  path: string;
  workspace: string;
}
