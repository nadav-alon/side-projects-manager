import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { packagePins } from "./package-pins.ts";
import { releaseTag } from "./ports/index.ts";

describe("packagePins", () => {
  it("reads a github tag pin from each dependency section", () => {
    const json = JSON.stringify({
      dependencies: { "household-ui": "github:nadav-alon/household-ui#v0.1.0" },
      devDependencies: { "data-platform": "github:nadav-alon/data-platform#v0.17.0" },
    });
    assert.deepEqual(packagePins(json, "nadav-alon"), [
      { package: "household-ui", tag: releaseTag("v0.1.0") },
      { package: "data-platform", tag: releaseTag("v0.17.0") },
    ]);
  });

  it("ignores another owner, a branch pin, a registry range and a missing tag", () => {
    const json = JSON.stringify({
      dependencies: {
        a: "github:someone/a#v1.0.0",
        b: "github:nadav-alon/b#main",
        c: "^1.2.3",
        d: "github:nadav-alon/d",
      },
    });
    assert.deepEqual(packagePins(json, "nadav-alon"), []);
  });

  it("yields none for text that is not a JSON object", () => {
    assert.deepEqual(packagePins("not json", "nadav-alon"), []);
    assert.deepEqual(packagePins("null", "nadav-alon"), []);
  });
});
