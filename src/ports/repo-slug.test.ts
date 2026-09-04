import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isRepoSlug, repoSlug } from "./repo-slug.ts";

describe("isRepoSlug", () => {
  it("accepts owner/repo", () => {
    assert.equal(isRepoSlug("nadav-alon/side-projects-manager"), true);
    assert.equal(isRepoSlug("a/b"), true);
    assert.equal(isRepoSlug("Owner-1/repo.name_2"), true);
  });

  it("rejects an underscore in the owner, which GitHub does not allow", () => {
    assert.equal(isRepoSlug("nadav_alon/pilot"), false);
  });

  it("rejects anything that is not exactly two segments", () => {
    assert.equal(isRepoSlug("side-projects-manager"), false);
    assert.equal(isRepoSlug("nadav-alon/side/projects"), false);
    assert.equal(isRepoSlug("nadav-alon/"), false);
    assert.equal(isRepoSlug("/pilot"), false);
  });

  it("rejects a URL, which is the shape most likely to be passed by mistake", () => {
    assert.equal(isRepoSlug("https://github.com/nadav-alon/pilot"), false);
  });

  it("rejects owners GitHub itself would reject", () => {
    assert.equal(isRepoSlug("-nadav/pilot"), false);
    assert.equal(isRepoSlug("nadav-/pilot"), false);
    assert.equal(isRepoSlug("nadav--alon/pilot"), false);
    assert.equal(isRepoSlug(`${"a".repeat(40)}/pilot`), false);
  });

  it("rejects repo names GitHub itself would reject", () => {
    assert.equal(isRepoSlug("nadav-alon/."), false);
    assert.equal(isRepoSlug("nadav-alon/.."), false);
    assert.equal(isRepoSlug("nadav-alon/pi lot"), false);
  });
});

describe("repoSlug", () => {
  it("returns the value it was given", () => {
    assert.equal(repoSlug("nadav-alon/pilot"), "nadav-alon/pilot");
  });

  it("throws naming the offending value", () => {
    assert.throws(() => repoSlug("pilot"), {
      name: "TypeError",
      message: /pilot/,
    });
  });
});
