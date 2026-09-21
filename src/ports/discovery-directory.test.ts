import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  discoveryDirectory,
  isDiscoveryDirectory,
} from "./discovery-directory.ts";

describe("isDiscoveryDirectory", () => {
  it("accepts a normalised absolute path", () => {
    assert.ok(isDiscoveryDirectory("/home/manager/discoveries/run-abc123"));
  });

  it("refuses a relative path, which no adapter could resolve twice", () => {
    assert.equal(isDiscoveryDirectory("discoveries"), false);
    assert.equal(isDiscoveryDirectory("./discoveries"), false);
    assert.equal(isDiscoveryDirectory(""), false);
  });

  /** Two spellings of one directory must not read as two discoveries directories. */
  it("refuses a path that is not already in join's shape", () => {
    assert.equal(isDiscoveryDirectory("/tmp/../discoveries"), false);
    assert.equal(isDiscoveryDirectory("/tmp//discoveries"), false);
    assert.equal(isDiscoveryDirectory("/tmp/discoveries/"), false);
  });
});

describe("discoveryDirectory", () => {
  it("narrows an absolute path", () => {
    assert.equal(discoveryDirectory("/tmp/discoveries"), "/tmp/discoveries");
  });

  it("throws naming the value it refused", () => {
    assert.throws(() => discoveryDirectory("discoveries"), /discoveries/);
  });
});
