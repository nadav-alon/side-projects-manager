import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MODEL_LABEL_PREFIX,
  READY_FOR_AGENT_LABEL,
  modelLabelOf,
  ticketKind,
} from "./issue-tracker.ts";
import { modelName } from "./model-name.ts";
import { pullRequestUrl } from "./pull-request-url.ts";
import { repoSlug } from "./repo-slug.ts";

const PILOT = repoSlug("nadav-alon/pilot");

describe("ticketKind", () => {
  it("reads a ticket naming a pull request as a review", () => {
    const ticket = {
      repo: PILOT,
      number: 13,
      title: "Review #12",
      pullRequest: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
    };

    assert.equal(ticketKind(ticket), "review");
  });

  it("reads a ticket naming no pull request as an implementation", () => {
    assert.equal(
      ticketKind({ repo: PILOT, number: 12, title: "Add a thing" }),
      "implementation",
    );
  });
});

describe("modelLabelOf", () => {
  it("names no model for a ticket without a model label", () => {
    assert.equal(modelLabelOf([READY_FOR_AGENT_LABEL, "enhancement"]), undefined);
    assert.equal(modelLabelOf([]), undefined);
  });

  it("names the model a single model label names", () => {
    assert.deepEqual(modelLabelOf([READY_FOR_AGENT_LABEL, "model:opus"]), {
      kind: "named",
      name: modelName("opus"),
    });
  });

  it("passes the name through as written, whatever it is", () => {
    assert.deepEqual(modelLabelOf(["model:Not-A-Claude-Model"]), {
      kind: "named",
      name: modelName("Not-A-Claude-Model"),
    });
  });

  it("marks two model labels as conflicting, carrying every name", () => {
    assert.deepEqual(modelLabelOf(["model:opus", "bug", "model:haiku"]), {
      kind: "conflicting",
      names: [modelName("opus"), modelName("haiku")],
      labels: ["model:opus", "model:haiku"],
    });
  });

  it("keeps conflicting labels as written, whatever the prefix's case", () => {
    assert.deepEqual(modelLabelOf(["Model:Opus", "model:haiku"]), {
      kind: "conflicting",
      names: [modelName("Opus"), modelName("haiku")],
      labels: ["Model:Opus", "model:haiku"],
    });
  });

  it("reads only labels that start with the prefix, whatever its case", () => {
    assert.equal(MODEL_LABEL_PREFIX, "model:");
    assert.equal(modelLabelOf(["my-model:opus", "models:opus"]), undefined);
    assert.deepEqual(modelLabelOf(["MODEL:Opus"]), {
      kind: "named",
      name: modelName("Opus"),
    });
  });

  it("marks a bare prefix unusable, since it is a model label naming no model", () => {
    assert.deepEqual(modelLabelOf(["model:"]), {
      kind: "unusable",
      labels: ["model:"],
    });
  });

  it("marks a name no run could be handed unusable, carrying the labels as written", () => {
    assert.deepEqual(
      modelLabelOf(["model: opus", "bug", "model:claude opus", "model:-p"]),
      {
        kind: "unusable",
        labels: ["model: opus", "model:claude opus", "model:-p"],
      },
    );
  });

  it("marks a ticket unusable even beside a usable model label", () => {
    assert.deepEqual(modelLabelOf(["model:opus", "model:"]), {
      kind: "unusable",
      labels: ["model:"],
    });
  });
});
