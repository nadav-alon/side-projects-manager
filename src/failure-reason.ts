import { modelProblem } from "./model-resolution.ts";
import type { RunFailure, UniformFilesTouched } from "./iteration-outcome.ts";
import type { Ticket } from "./ports/index.ts";
import { sizeProblem } from "./size-resolution.ts";

/**
 * Why `failure` ended `ticket`'s iteration, as the words a person watching the
 * invocation reads after "Failed <repo> #<n>:". Free text: it may run long or
 * span lines, and a caller that needs one line flattens it.
 */
export function failureReason(ticket: Ticket, failure: RunFailure): string {
  switch (failure.kind) {
    case "gave-up":
    case "handover-failed":
    case "infrastructure":
    case "unsettled-mergeability":
      return failure.reason;
    case "model-refused":
    case "conflicting-model-labels":
    case "unusable-model-label":
      return modelProblem(ticket, failure).problem;
    case "unusable-size-label":
      return sizeProblem(failure).problem;
    case "uniform-files-touched":
      return uniformFilesTouchedPhrase(failure);
  }
}

/**
 * The phrase a uniform-files-touched failure reads as: shared by
 * `failureReason`, `waitingOnFailure` and `stoppedBecause`, so a wording
 * change touches one place.
 */
export function uniformFilesTouchedPhrase(failure: UniformFilesTouched): string {
  return `its diff touched ${failure.files.join(", ")}, which the manager keeps uniform across every project, so no pull request was opened`;
}
