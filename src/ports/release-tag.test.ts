import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isOlderTag, isReleaseTag, releaseTag } from "./release-tag.ts";

describe("isReleaseTag", () => {
  it("accepts v and a dotted numeric version", () => {
    assert.equal(isReleaseTag("v0.5.1"), true);
    assert.equal(isReleaseTag("v12"), true);
  });

  it("rejects anything else", () => {
    assert.equal(isReleaseTag("0.5.1"), false);
    assert.equal(isReleaseTag("main"), false);
    assert.equal(isReleaseTag("v1.2.3-beta"), false);
    assert.equal(isReleaseTag(""), false);
  });
});

describe("releaseTag", () => {
  it("throws naming the offending value", () => {
    assert.throws(() => releaseTag("main"), /"main"/);
  });
});

describe("isOlderTag", () => {
  it("compares numerically, not as text", () => {
    assert.equal(isOlderTag(releaseTag("v0.17.0"), releaseTag("v0.27.0")), true);
    assert.equal(isOlderTag(releaseTag("v0.9.0"), releaseTag("v0.10.0")), true);
  });

  it("is false for the same or a newer tag", () => {
    assert.equal(isOlderTag(releaseTag("v0.5.1"), releaseTag("v0.5.1")), false);
    assert.equal(isOlderTag(releaseTag("v1.0.0"), releaseTag("v0.9.9")), false);
  });

  it("reads a missing part as zero", () => {
    assert.equal(isOlderTag(releaseTag("v1"), releaseTag("v1.0.0")), false);
    assert.equal(isOlderTag(releaseTag("v1"), releaseTag("v1.0.1")), true);
  });
});
