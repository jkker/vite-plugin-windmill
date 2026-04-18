import { devRuntimeSource } from "./dev-runtime-source.ts";
import { buildRuntimeSource } from "./generated/upstream-build-runtime.ts";

export const getWindmillRuntimeSource = (mode: "build" | "serve"): string =>
  mode === "serve" ? devRuntimeSource : buildRuntimeSource;

export { buildRuntimeSource, devRuntimeSource };
