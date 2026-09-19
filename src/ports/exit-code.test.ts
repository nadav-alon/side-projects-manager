import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { exitCode, isExitCode } from "./exit-code.ts";

describe("isExitCode", () => {
  it("accepts 0", () => {
    assert.equal(isExitCode(0), true);
  });

  it("accepts 255, the top of the range an OS reports", () => {
    assert.equal(isExitCode(255), true);
  });

  it("rejects a negative number", () => {
    assert.equal(isExitCode(-1), false);
  });

  it("rejects anything above 255", () => {
    assert.equal(isExitCode(256), false);
  });

  it("rejects a fractional number", () => {
    assert.equal(isExitCode(1.5), false);
  });
});

describe("exitCode", () => {
  it("returns the value it was given", () => {
    assert.equal(exitCode(130), 130);
  });

  it("throws naming the offending value", () => {
    assert.throws(() => exitCode(-1), {
      name: "TypeError",
      message: /-1/,
    });
  });
});
