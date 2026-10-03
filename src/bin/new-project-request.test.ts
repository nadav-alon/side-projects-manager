import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { repoSlug } from "../ports/index.ts";
import { parseRequest } from "./new-project-request.ts";

const PILOT = repoSlug("nadav-alon/pilot");

describe("parsing a new-project request", () => {
  it("carries --public through as public: true", () => {
    const request = parseRequest(["nadav-alon/pilot", "--public"]);

    assert.equal(request.repo, PILOT);
    assert.equal(request.public, true);
  });

  it("defaults public to false without --public", () => {
    const request = parseRequest(["nadav-alon/pilot"]);

    assert.equal(request.public, false);
  });

  it("carries --standards through as the preset's name", () => {
    const request = parseRequest(["nadav-alon/pilot", "--standards", "typescript"]);

    assert.equal(request.standards, "typescript");
  });

  it("leaves standards unset without --standards", () => {
    assert.equal(parseRequest(["nadav-alon/pilot"]).standards, undefined);
  });

  it("refuses --public together with --existing", () => {
    assert.throws(
      () => parseRequest(["nadav-alon/pilot", "--existing", "--public"]),
      /--public creates a repo; with --existing the repo already exists/,
    );
  });
});
