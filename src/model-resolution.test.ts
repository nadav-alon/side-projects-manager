import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { modelProblem, modelRefused, resolveModel } from "./model-resolution.ts";
import {
  issueNumber,
  modelLabelOf,
  modelName,
  pullRequestUrl,
  type ModelDefaults,
  type Ticket,
} from "./ports/index.ts";
import { PILOT } from "./testing/index.ts";

const REVIEW_PULL_REQUEST = pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12");

function implementationTicket(labels: string[] = []): Ticket {
  const modelLabel = modelLabelOf(labels);
  return {
    repo: PILOT,
    number: issueNumber(7),
    title: "Add the thing",
    ...(modelLabel !== undefined && { modelLabel }),
  };
}

function reviewTicket(labels: string[] = []): Ticket {
  const modelLabel = modelLabelOf(labels);
  return {
    repo: PILOT,
    number: issueNumber(8),
    title: "Review #7",
    pullRequest: { kind: "review", url: REVIEW_PULL_REQUEST },
    ...(modelLabel !== undefined && { modelLabel }),
  };
}

describe("resolveModel", () => {
  const cases: Array<{
    name: string;
    ticket: Ticket;
    defaults: ModelDefaults;
    expected: ReturnType<typeof resolveModel>;
  }> = [
    {
      name: "a named model label, with no model defaults at all",
      ticket: implementationTicket(["model:opus"]),
      defaults: {},
      expected: { kind: "resolved", model: { name: modelName("opus"), source: "model label" } },
    },
    {
      name: "a named model label, over a model default for the same kind",
      ticket: implementationTicket(["model:opus"]),
      defaults: { implementation: modelName("haiku") },
      expected: { kind: "resolved", model: { name: modelName("opus"), source: "model label" } },
    },
    {
      name: "no label, and a model default for the ticket's own kind",
      ticket: implementationTicket(),
      defaults: { implementation: modelName("haiku") },
      expected: { kind: "resolved", model: { name: modelName("haiku"), source: "model defaults" } },
    },
    {
      name: "no label, and a model default for a different kind",
      ticket: reviewTicket(),
      defaults: { implementation: modelName("haiku") },
      expected: { kind: "none" },
    },
    {
      name: "no label, and no model defaults at all",
      ticket: implementationTicket(),
      defaults: {},
      expected: { kind: "none" },
    },
    // A review ticket whose parent carries a model label is not a case this
    // table can express: `Ticket` carries no link to a parent, and
    // non-inheritance is fixed at the tracker port, out of this ticket's
    // scope. This case only shows a review ticket reads the `review` entry
    // of the model defaults, not the `implementation` one.
    {
      name: "a review ticket reads the model defaults' review entry, not its implementation entry",
      ticket: reviewTicket(),
      defaults: { review: modelName("sonnet") },
      expected: { kind: "resolved", model: { name: modelName("sonnet"), source: "model defaults" } },
    },
    {
      name: "conflicting model labels, whatever the model defaults say",
      ticket: implementationTicket(["model:opus", "model:haiku"]),
      defaults: { implementation: modelName("sonnet") },
      expected: {
        kind: "refused",
        failure: {
          kind: "conflicting-model-labels",
          reason: "it carries more than one model label (model:opus, model:haiku)",
          labels: ["model:opus", "model:haiku"],
        },
      },
    },
    {
      name: "a model label naming no usable model",
      ticket: implementationTicket(["model:"]),
      defaults: { implementation: modelName("sonnet") },
      expected: {
        kind: "refused",
        failure: {
          kind: "unusable-model-label",
          reason: "its model label names no usable model (model:)",
          labels: ["model:"],
        },
      },
    },
  ];

  for (const { name, ticket, defaults, expected } of cases) {
    it(`resolves ${name}`, () => {
      assert.deepEqual(resolveModel(ticket, defaults), expected);
    });
  }
});

describe("modelRefused", () => {
  it("names the model label as the source, when the refused model is the one it names", () => {
    const ticket = implementationTicket(["model:opus"]);

    const failure = modelRefused(ticket, { model: modelName("opus"), words: "unknown model opus" });

    assert.equal(failure.source, "model label");
    assert.match(failure.reason, /from the model label/);
  });

  it("names the model defaults as the source, for a ticket carrying no model label", () => {
    const ticket = reviewTicket();

    const failure = modelRefused(ticket, { model: modelName("haiku"), words: "unknown model haiku" });

    assert.equal(failure.source, "model defaults");
    assert.match(failure.reason, /from the model defaults/);
  });
});

describe("modelProblem", () => {
  it("names the labels and says to keep one, for conflicting model labels", () => {
    const { problem, fix } = modelProblem(implementationTicket(), {
      kind: "conflicting-model-labels",
      reason: "it carries more than one model label (model:opus, model:haiku)",
      labels: ["model:opus", "model:haiku"],
    });

    assert.match(problem, /`model:opus`/);
    assert.match(problem, /`model:haiku`/);
    assert.match(fix, /keep one/i);
  });

  it("names the labels and the expected shape, for an unusable model label", () => {
    const { problem, fix } = modelProblem(implementationTicket(), {
      kind: "unusable-model-label",
      reason: "its model label names no usable model (model:)",
      labels: ["model:"],
    });

    assert.match(problem, /`model:`/);
    assert.match(fix, /fix or remove it/);
  });

  it("points at the model label, for a model refusal sourced from one", () => {
    const { problem, fix } = modelProblem(implementationTicket(["model:opus"]), {
      kind: "model-refused",
      reason: "the agent CLI refused the model opus (from the model label): unknown model opus",
      refusal: { model: modelName("opus"), words: "unknown model opus" },
      source: "model label",
    });

    assert.match(problem, /model label/);
    assert.match(fix, /fix or remove its model label/);
  });

  it("points at models.json and the ticket's own kind, for a model refusal sourced from the defaults", () => {
    const { problem, fix } = modelProblem(reviewTicket(), {
      kind: "model-refused",
      reason: "the agent CLI refused the model haiku (from the model defaults): unknown model haiku",
      refusal: { model: modelName("haiku"), words: "unknown model haiku" },
      source: "model defaults",
    });

    assert.match(problem, /model defaults for review tickets/);
    assert.match(problem, /models\.json/);
    assert.match(fix, /fix the review model in `models\.json`/);
  });
});
