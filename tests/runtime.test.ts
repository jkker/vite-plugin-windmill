import { describe, expect, it } from "vite-plus/test";

import { buildRuntimeSource, devRuntimeSource, getWindmillRuntimeSource } from "../src/runtime.ts";

describe("runtime sources", () => {
  it("uses the generated upstream runtime for build mode", () => {
    expect(getWindmillRuntimeSource("build")).toBe(buildRuntimeSource);
    expect(buildRuntimeSource).toContain("export const backend = new Proxy");
    expect(buildRuntimeSource).not.toContain("type StreamUpdate");
  });

  it("uses the local dev runtime for serve mode", () => {
    expect(getWindmillRuntimeSource("serve")).toBe(devRuntimeSource);
    expect(devRuntimeSource).toContain("/__windmill__/backend");
  });
});
