import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { issueNumber } from "./issue-number.ts";
import {
  MODEL_LABEL_PREFIX,
  READY_FOR_AGENT_LABEL,
  SIZE_LABEL_PREFIX,
  SUPERTASK_LABEL,
  carriesReadyForAgent,
  carriesSupertaskLabel,
  declaredSize,
  isApplyReviewTicket,
  isPullRequestTicket,
  isRebaseTicket,
  isReviewTicket,
  isSupertask,
  modelLabelOf,
  sizeLabelOf,
  ticketKind,
  ticketPrioritiesIn,
  type OpenIssue,
} from "./issue-tracker.ts";
import { modelName } from "./model-name.ts";
import { pullRequestUrl } from "./pull-request-url.ts";
import { repoSlug } from "./repo-slug.ts";
import { ticketPriority } from "./ticket-priority.ts";

const PILOT = repoSlug("nadav-alon/pilot");

function openIssue(
  number: number,
  facts: { priority?: 1 | 2 | 3; parent?: number; blockers?: number[] } = {},
): OpenIssue {
  return {
    ticket: {
      repo: PILOT,
      number: issueNumber(number),
      title: `Issue ${number}`,
      ...(facts.priority === undefined
        ? {}
        : { priority: ticketPriority(facts.priority) }),
    },
    eligible: true,
    openBlockerNumbers: (facts.blockers ?? []).map(issueNumber),
    ...(facts.parent === undefined
      ? {}
      : { parent: issueNumber(facts.parent) }),
  };
}

/** Each issue's ticket priority as a plain object, for readable assertions. */
function prioritiesOf(...issues: OpenIssue[]): Record<number, number> {
  return Object.fromEntries(
    ticketPrioritiesIn({ issues, truncated: false }),
  );
}

describe("ticketPrioritiesIn", () => {
  it("carries a spec's priority label into its sub-issues and theirs", () => {
    assert.deepEqual(
      prioritiesOf(
        openIssue(1, { priority: 1 }),
        openIssue(2, { parent: 1 }),
        openIssue(3, { parent: 2 }),
      ),
      { 1: 1, 2: 1, 3: 1 },
    );
  });

  it("carries a ticket's priority label into its blockers and theirs", () => {
    assert.deepEqual(
      prioritiesOf(
        openIssue(1, { priority: 1, blockers: [2] }),
        openIssue(2, { blockers: [3] }),
        openIssue(3),
      ),
      { 1: 1, 2: 1, 3: 1 },
    );
  });

  it("carries a priority label along sub-issue and blocker steps in any mix", () => {
    assert.deepEqual(
      prioritiesOf(
        openIssue(4, { parent: 3 }),
        openIssue(3),
        openIssue(2, { parent: 1, blockers: [3] }),
        openIssue(1, { priority: 1 }),
      ),
      { 1: 1, 2: 1, 3: 1, 4: 1 },
    );
  });

  it("gives an issue the smallest of its own label and every label reaching it", () => {
    assert.deepEqual(
      prioritiesOf(
        openIssue(2, { priority: 3, parent: 1 }),
        openIssue(1, { priority: 1 }),
      ),
      { 1: 1, 2: 1 },
    );
    assert.deepEqual(
      prioritiesOf(
        openIssue(1, { priority: 3 }),
        openIssue(2, { priority: 1, parent: 1 }),
      ),
      { 1: 3, 2: 1 },
    );
  });

  it("lends nothing from a sub-issue to its parent or siblings", () => {
    assert.deepEqual(
      prioritiesOf(
        openIssue(1),
        openIssue(2, { priority: 1, parent: 1 }),
        openIssue(3, { parent: 1 }),
      ),
      { 2: 1 },
    );
  });

  it("lends nothing from a blocker to what it blocks", () => {
    assert.deepEqual(
      prioritiesOf(
        openIssue(1, { priority: 3, blockers: [2] }),
        openIssue(2, { priority: 1 }),
      ),
      { 1: 3, 2: 1 },
    );
  });

  it("takes nothing from a parent or blocker number it did not read", () => {
    assert.deepEqual(
      prioritiesOf(
        openIssue(1, { parent: 99, blockers: [98] }),
        openIssue(2, { priority: 2, blockers: [97] }),
      ),
      { 2: 2 },
    );
  });

  it("gives every issue in a blocked-by cycle the smallest label in it", () => {
    assert.deepEqual(
      prioritiesOf(
        openIssue(1, { priority: 3, blockers: [2] }),
        openIssue(2, { blockers: [3] }),
        openIssue(3, { priority: 2, blockers: [1] }),
      ),
      { 1: 2, 2: 2, 3: 2 },
    );
  });
});

describe("carriesReadyForAgent", () => {
  it("finds ready-for-agent among other labels, whatever its case", () => {
    assert.equal(carriesReadyForAgent(["bug", READY_FOR_AGENT_LABEL]), true);
    assert.equal(carriesReadyForAgent(["Ready-For-Agent"]), true);
  });

  it("finds nothing in labels without it", () => {
    assert.equal(carriesReadyForAgent(["ready-for-human", "ready"]), false);
    assert.equal(carriesReadyForAgent([]), false);
  });
});

describe("carriesSupertaskLabel", () => {
  it("finds the supertask label among other labels, whatever its case", () => {
    assert.equal(carriesSupertaskLabel(["bug", SUPERTASK_LABEL]), true);
    assert.equal(carriesSupertaskLabel(["Supertask"]), true);
  });

  it("finds nothing in labels without it", () => {
    assert.equal(carriesSupertaskLabel(["ready-for-agent", "super"]), false);
    assert.equal(carriesSupertaskLabel([]), false);
  });
});

describe("isSupertask", () => {
  it("reads true only when the ticket carries the supertask fact", () => {
    assert.equal(
      isSupertask({ repo: PILOT, number: issueNumber(1), title: "x", supertask: true }),
      true,
    );
    assert.equal(
      isSupertask({ repo: PILOT, number: issueNumber(2), title: "y" }),
      false,
    );
  });
});

const PULL_REQUEST = pullRequestUrl(
  "https://github.com/nadav-alon/pilot/pull/12",
);

describe("ticketKind", () => {
  it("reads a ticket bound to a review as a review", () => {
    const ticket = {
      repo: PILOT,
      number: issueNumber(13),
      title: "Review #12",
      pullRequest: { kind: "review" as const, url: PULL_REQUEST },
    };

    assert.equal(ticketKind(ticket), "review");
  });

  it("reads a ticket bound to an apply-review as an apply-review", () => {
    const ticket = {
      repo: PILOT,
      number: issueNumber(13),
      title: "Apply the review",
      pullRequest: { kind: "apply-review" as const, url: PULL_REQUEST },
    };

    assert.equal(ticketKind(ticket), "apply-review");
  });

  it("reads a ticket bound to a rebase as a rebase", () => {
    const ticket = {
      repo: PILOT,
      number: issueNumber(13),
      title: "Rebase #12",
      pullRequest: { kind: "rebase" as const, url: PULL_REQUEST },
    };

    assert.equal(ticketKind(ticket), "rebase");
  });

  it("reads a ticket naming no pull request as an implementation", () => {
    assert.equal(
      ticketKind({ repo: PILOT, number: issueNumber(12), title: "Add a thing" }),
      "implementation",
    );
  });
});

describe("isReviewTicket, isApplyReviewTicket, isRebaseTicket and isPullRequestTicket", () => {
  const review = {
    repo: PILOT,
    number: issueNumber(13),
    title: "Review #12",
    pullRequest: { kind: "review" as const, url: PULL_REQUEST },
  };
  const applyReview = {
    repo: PILOT,
    number: issueNumber(14),
    title: "Apply the review",
    pullRequest: { kind: "apply-review" as const, url: PULL_REQUEST },
  };
  const rebase = {
    repo: PILOT,
    number: issueNumber(15),
    title: "Rebase #12",
    pullRequest: { kind: "rebase" as const, url: PULL_REQUEST },
  };
  const implementation = { repo: PILOT, number: issueNumber(12), title: "Add a thing" };

  it("tells a review ticket from the other three kinds", () => {
    assert.equal(isReviewTicket(review), true);
    assert.equal(isReviewTicket(applyReview), false);
    assert.equal(isReviewTicket(rebase), false);
    assert.equal(isReviewTicket(implementation), false);
  });

  it("tells an apply-review ticket from the other three kinds", () => {
    assert.equal(isApplyReviewTicket(applyReview), true);
    assert.equal(isApplyReviewTicket(review), false);
    assert.equal(isApplyReviewTicket(rebase), false);
    assert.equal(isApplyReviewTicket(implementation), false);
  });

  it("tells a rebase ticket from the other three kinds", () => {
    assert.equal(isRebaseTicket(rebase), true);
    assert.equal(isRebaseTicket(review), false);
    assert.equal(isRebaseTicket(applyReview), false);
    assert.equal(isRebaseTicket(implementation), false);
  });

  it("tells a pull-request-bound ticket, of any of the three kinds, from an implementation", () => {
    assert.equal(isPullRequestTicket(review), true);
    assert.equal(isPullRequestTicket(applyReview), true);
    assert.equal(isPullRequestTicket(rebase), true);
    assert.equal(isPullRequestTicket(implementation), false);
  });

  it("reads an implementation ticket's own declared size", () => {
    const sized = { ...implementation, sizeLabel: { kind: "declared" as const, size: "L" as const } };

    assert.equal(declaredSize(sized), "L");
  });

  it("names no size for an implementation ticket that declares none", () => {
    assert.equal(declaredSize(implementation), undefined);
  });

  it("names no size for a pull request ticket, whatever it declares", () => {
    const sized = { ...review, sizeLabel: { kind: "declared" as const, size: "L" as const } };

    assert.equal(declaredSize(sized), undefined);
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

describe("sizeLabelOf", () => {
  it("declares no size for a ticket without a size label", () => {
    assert.equal(sizeLabelOf([READY_FOR_AGENT_LABEL, "enhancement"]), undefined);
    assert.equal(sizeLabelOf([]), undefined);
  });

  for (const letter of ["S", "M", "L", "XL"] as const) {
    it(`declares ${letter} for a ticket labelled size:${letter}`, () => {
      assert.deepEqual(sizeLabelOf([READY_FOR_AGENT_LABEL, `size:${letter}`]), {
        kind: "declared",
        size: letter,
      });
    });
  }

  it("counts the larger of two declared sizes, whichever order they're labelled in", () => {
    assert.deepEqual(sizeLabelOf(["size:S", "size:L"]), {
      kind: "declared",
      size: "L",
    });
    assert.deepEqual(sizeLabelOf(["size:XL", "size:M"]), {
      kind: "declared",
      size: "XL",
    });
  });

  it("reads only labels that start with the prefix, whatever its case", () => {
    assert.equal(SIZE_LABEL_PREFIX, "size:");
    assert.equal(sizeLabelOf(["my-size:S", "sizes:S"]), undefined);
    assert.deepEqual(sizeLabelOf(["SIZE:m"]), {
      kind: "declared",
      size: "M",
    });
  });

  it("marks a size label naming no recognised size unusable, carrying it as written", () => {
    assert.deepEqual(sizeLabelOf(["size:huge"]), {
      kind: "unusable",
      labels: ["size:huge"],
    });
  });

  it("marks a ticket unusable even beside a recognised size", () => {
    assert.deepEqual(sizeLabelOf(["size:S", "size:huge"]), {
      kind: "unusable",
      labels: ["size:huge"],
    });
  });
});
