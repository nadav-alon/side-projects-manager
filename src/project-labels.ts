/** A label a project's repo carries, with the description it is created under. */
export interface ProjectLabel {
  name: string;
  description: string;
}

/**
 * Every label the manager's docs and skills tell people to apply, which
 * `docs/agents/triage-labels.md` names, plus the two skills apply on their own
 * (`needs-grilling`, `ux-review`). A project has them all from the start: the
 * manager creates only the labels it applies itself, lazily, so any other
 * would fail the first `gh issue edit --add-label`.
 */
export const PROJECT_LABELS: readonly ProjectLabel[] = [
  { name: "needs-triage", description: "Maintainer needs to evaluate this issue" },
  { name: "needs-info", description: "Waiting on reporter for more information" },
  { name: "ready-for-agent", description: "Fully specified, ready for an AFK agent" },
  { name: "ready-for-human", description: "Requires human implementation" },
  { name: "wontfix", description: "Will not be actioned" },
  { name: "priority:1", description: "Work before everything else" },
  { name: "priority:2", description: "Work before unlabelled tickets" },
  { name: "priority:3", description: "Work before unlabelled tickets, after priority:2" },
  { name: "size:S", description: "Smallest" },
  { name: "size:M", description: "Larger than S, smaller than L" },
  { name: "size:L", description: "Larger than M, smaller than XL" },
  { name: "size:XL", description: "Largest" },
  { name: "supertask", description: "A container ticket" },
  {
    name: "spec-review",
    description: "Reviews the repo against a supertask's body; reports, never commits.",
  },
  { name: "enhancement", description: "New feature or request" },
  { name: "ready-discovery", description: "Born from a discovery its filer declared ready" },
  {
    name: "live-write",
    description: "Consents to this ticket's run writing the project's mounted directories",
  },
  {
    name: "turboable",
    description: "Consents to the manager merging this ticket's pull request",
  },
  { name: "needs-grilling", description: "Needs a grilling before it can be specified" },
  { name: "ux-review", description: "Needs a review of its user experience" },
];
