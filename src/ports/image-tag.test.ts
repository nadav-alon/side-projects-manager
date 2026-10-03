import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { imageTag, isImageTag } from "./image-tag.ts";

describe("isImageTag", () => {
  it("accepts name:tag", () => {
    assert.ok(isImageTag("side-projects-sandbox:latest"));
    assert.ok(isImageTag("side-projects-sandbox:nadav-alon-ltlf.external"));
  });

  it("refuses a bare name, whitespace and an uppercase name", () => {
    for (const value of ["", "side-projects-sandbox", "a b:c", "Name:tag", "name:", "name:-x"]) {
      assert.equal(isImageTag(value), false, value);
    }
  });
});

describe("imageTag", () => {
  it("throws naming a value that is not one", () => {
    assert.throws(() => imageTag("nope"), /Not an image tag.*nope/);
  });
});
