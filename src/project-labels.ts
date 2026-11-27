import {
  DESIGN_REVIEW_LABEL,
  ENHANCEMENT_LABEL,
  LIVE_WRITE_LABEL,
  NEEDS_TRIAGE_LABEL,
  READY_DISCOVERY_LABEL,
  READY_FOR_AGENT_LABEL,
  READY_FOR_HUMAN_LABEL,
  SIZE_LABEL_PREFIX,
  SPEC_REVIEW_LABEL,
  SUPERTASK_LABEL,
  TURBOABLE_LABEL,
  UX_REVIEW_LABEL,
} from "./ports/index.ts";

/** A label a project's repo carries, with the description it is created under. */
export interface ProjectLabel {
  name: string;
  description: string;
}

/**
 * What every label the manager's docs and skills tell people to apply says
 * about itself, as `docs/agents/triage-labels.md` describes it, plus the two
 * skills apply on their own (`needs-grilling`, `ux-review`, `design-review`). The one place the
 * descriptions live: `new-project` creates every label from it, and the issue
 * tracker creates the ones it applies itself, lazily, from the same entries, so
 * the two cannot drift apart.
 */
export const LABEL_DESCRIPTIONS = {
  [NEEDS_TRIAGE_LABEL]: "Maintainer needs to evaluate this issue",
  "needs-info": "Waiting on reporter for more information",
  [READY_FOR_AGENT_LABEL]: "Fully specified, ready for an AFK agent",
  [READY_FOR_HUMAN_LABEL]: "Requires human implementation",
  wontfix: "Will not be actioned",
  "priority:1": "Work before everything else",
  "priority:2": "Work before unlabelled tickets",
  "priority:3": "Work before unlabelled tickets, after priority:2",
  [`${SIZE_LABEL_PREFIX}S`]: "Smallest",
  [`${SIZE_LABEL_PREFIX}M`]: "Larger than S, smaller than L",
  [`${SIZE_LABEL_PREFIX}L`]: "Larger than M, smaller than XL",
  [`${SIZE_LABEL_PREFIX}XL`]: "Largest",
  [SUPERTASK_LABEL]: "A container ticket",
  [SPEC_REVIEW_LABEL]:
    "Reviews the repo against a supertask's body; reports, never commits.",
  [ENHANCEMENT_LABEL]: "New feature or request",
  [READY_DISCOVERY_LABEL]: "Born from a discovery its filer declared ready",
  [LIVE_WRITE_LABEL]:
    "Consents to this ticket's run writing the project's mounted directories",
  [TURBOABLE_LABEL]: "Consents to the manager merging this ticket's pull request",
  "needs-grilling": "Needs a grilling before it can be specified",
  [UX_REVIEW_LABEL]: "Needs a review of its user experience",
  [DESIGN_REVIEW_LABEL]: "Needs a review of its visual design against Material 3",
} as const;

/**
 * Every label a project has from the start: the manager creates only the
 * labels it applies itself, lazily, so any other would fail the first
 * `gh issue edit --add-label`.
 */
export const PROJECT_LABELS: readonly ProjectLabel[] = Object.entries(
  LABEL_DESCRIPTIONS,
).map(([name, description]) => ({ name, description }));
