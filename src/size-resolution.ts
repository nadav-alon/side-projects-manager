import type { UnusableSizeLabel } from "./iteration-outcome.ts";
import type { Ticket } from "./ports/index.ts";
import { isPullRequestTicket } from "./ports/index.ts";
import { labelList, type ModelProblem } from "./model-resolution.ts";

/**
 * Why no run can be started on `ticket`'s size label, absent when it names a
 * recognised size, names none, or belongs to a pull request ticket — whose
 * size label `runEstimate` (`budget-gate.ts`) always ignores, so it is never
 * unusable. Never falls back to `unsizedCountsAs`: the developer named a
 * size, and running the ticket as though it were unsized is not what they
 * asked for.
 */
export function unusableSizeLabel(ticket: Ticket): UnusableSizeLabel | undefined {
  const label = ticket.sizeLabel;
  if (isPullRequestTicket(ticket) || label?.kind !== "unusable") {
    return undefined;
  }
  return { kind: "unusable-size-label", labels: label.labels };
}

/**
 * The words explaining `failure`, and how to fix it — the one source
 * `hand-back.ts`'s comment and `summary.ts`'s one-line digest both read
 * from, so the wording never drifts between the two. Returns `ModelProblem`
 * (`model-resolution.ts`) rather than a same-shaped type of its own: the two
 * failures render into the same `problem`/`fix` pair, and every caller reads
 * both the same way.
 *
 * `problem` carries only the "why": the label shape a size label must take
 * stays out of it, since `hand-back.ts`'s own comment appends that on its
 * own as an instruction for fixing the ticket, not the reason it failed.
 */
export function sizeProblem(failure: UnusableSizeLabel): ModelProblem {
  return {
    problem: `its size label names no size the budget document knows (${labelList(failure.labels)})`,
    fix: "fix or remove it",
  };
}
