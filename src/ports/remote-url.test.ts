import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isRemoteUrl, remoteUrl } from "./remote-url.ts";

describe("isRemoteUrl", () => {
  it("accepts every shape a checkout's origin comes in", () => {
    for (const value of [
      "https://github.com/nadav-alon/pilot.git",
      "http://git.example.com/pilot",
      "ssh://git@github.com/nadav-alon/pilot.git",
      "git@github.com:nadav-alon/pilot.git",
      "git://example.com/pilot.git",
      "file:///srv/git/pilot",
      "/srv/git/pilot",
      "/tmp/My Projects/pilot",
    ]) {
      assert.ok(isRemoteUrl(value), `expected to accept ${value}`);
    }
  });

  it("refuses what no remote is addressed as", () => {
    for (const value of [
      "",
      "pilot",
      "../pilot",
      "https://github.com/",
      "mailto:someone@example.com",
      "https://github.com/nadav-alon/pilot.git\nfatal: something",
    ]) {
      assert.equal(isRemoteUrl(value), false, `expected to refuse ${value}`);
    }
  });
});

describe("remoteUrl", () => {
  it("narrows an address git can reach", () => {
    assert.equal(remoteUrl("/srv/git/pilot"), "/srv/git/pilot");
  });

  it("throws naming the value it refused", () => {
    assert.throws(() => remoteUrl("../pilot"), /\.\.\/pilot/);
  });
});
