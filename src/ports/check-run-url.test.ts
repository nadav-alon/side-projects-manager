import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkRunUrl, isCheckRunUrl } from "./check-run-url.ts";

describe("isCheckRunUrl", () => {
  it("accepts an Actions run and another CI service's page", () => {
    assert.ok(isCheckRunUrl("https://github.com/nadav-alon/pilot/actions/runs/1/job/2"));
    assert.ok(isCheckRunUrl("http://ci.example.test/build/9"));
  });

  it("refuses what is not an http(s) URL", () => {
    assert.equal(isCheckRunUrl(""), false);
    assert.equal(isCheckRunUrl("actions/runs/1"), false);
    assert.equal(isCheckRunUrl("git@github.com:nadav-alon/pilot"), false);
  });
});

describe("checkRunUrl", () => {
  it("narrows a run's address", () => {
    assert.equal(checkRunUrl("https://ci.example.test/1"), "https://ci.example.test/1");
  });

  it("throws on anything else", () => {
    assert.throws(() => checkRunUrl("not a url"), TypeError);
  });
});
