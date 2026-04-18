import { describe, expect, it } from "vite-plus/test";

import {
  COMPATIBILITY_BLOCK_END,
  COMPATIBILITY_BLOCK_START,
  compareVersions,
  replaceCompatibilityBlock,
  sanitizeRequestedVersion,
  toReleaseLineLabel,
  toReleaseVersion,
} from "../scripts/release-utils.mjs";

describe("release utils", () => {
  it("normalizes a Windmill version to the plugin release line", () => {
    expect(toReleaseVersion("1.687.3")).toBe("1.687.0");
    expect(toReleaseLineLabel("1.687.3")).toBe("1.687.x");
  });

  it("sorts semantic versions numerically", () => {
    expect(["1.10.0", "1.2.9", "1.2.10"].toSorted(compareVersions)).toEqual([
      "1.2.9",
      "1.2.10",
      "1.10.0",
    ]);
  });

  it("strips a leading v from manual release inputs", () => {
    expect(sanitizeRequestedVersion("v1.687.0")).toBe("1.687.0");
  });

  it("rewrites the README compatibility block in place", () => {
    const readme = [
      "before",
      COMPATIBILITY_BLOCK_START,
      "old compatibility text",
      COMPATIBILITY_BLOCK_END,
      "after",
    ].join("\n");

    const updated = replaceCompatibilityBlock(readme, { windmillVersion: "1.687.0" });

    expect(updated).toContain("Current release line: `1.687.x`");
    expect(updated).toContain("windmill-client@^1.687.0");
    expect(updated).toContain("windmill-labs/windmill@v1.687.0");
    expect(updated.startsWith("before\n")).toBe(true);
    expect(updated.endsWith("\nafter")).toBe(true);
  });
});
