import type { InvocationReport, InvocationStandDown } from "./morning-run.ts";
import { handedBackForModelLabels } from "./iteration-outcome.ts";
import type {
  ExitCode,
  InvocationClosing,
  JournaledProject,
  RepoSlug,
} from "./ports/index.ts";
import { tokenCount } from "./ports/index.ts";

/**
 * `report` as the journal records it: what the invocation came to, every
 * project it actually worked with what all its runs together cost, and —
 * when it stood down — why.
 *
 * Lives beside the loop rather than inside it, the same reason recording
 * itself does: this is the composition root's account of a report the loop
 * already produced, not something the loop needs to know how to write.
 */
export function invocationClosing(
  report: InvocationReport,
  closedAt: Date,
): InvocationClosing {
  return {
    closedAt,
    outcome: report.outcome,
    projects: projectsWorked(report),
    ...(report.standDown !== undefined && {
      standDownReason: standDownReason(report.standDown),
    }),
  };
}

/**
 * How the guarded trigger closes a record for itself, when the loop's
 * process left none of its own: the invocation never reported, carrying the
 * exit code that process gave the trigger. The only `InvocationClosing`
 * authored outside the loop's own report — everything else here is `report`
 * as the journal records it.
 */
export function neverReportedClosing(
  closedAt: Date,
  exit: ExitCode,
): InvocationClosing {
  return { closedAt, outcome: "never-reported", projects: [], exitCode: exit };
}

/**
 * Every project an iteration actually ran against, and the tokens all its
 * iterations together spent.
 *
 * A ticket handed back for its model labels is left out: nothing was cloned,
 * run, or spent. Every other iteration names its project, even one that
 * failed before the sandbox spent anything — with `tokensUsed: 0` — since
 * the project was still worked.
 */
function projectsWorked(report: InvocationReport): JournaledProject[] {
  const totals = new Map<RepoSlug, number>();
  for (const iteration of report.iterations) {
    if (handedBackForModelLabels(iteration)) {
      continue;
    }
    const cost = iteration.tokensUsed ?? 0;
    totals.set(iteration.repo, (totals.get(iteration.repo) ?? 0) + cost);
  }
  return [...totals].map(([repo, tokensUsed]) => ({
    repo,
    tokensUsed: tokenCount(tokensUsed),
  }));
}

/** Why the invocation stood down, in one line for the journal. */
function standDownReason(standDown: InvocationStandDown): string {
  if (standDown.reason === "stopped") {
    return "stopped by hand";
  }
  if (standDown.reason === "provider-limit") {
    return standDown.limitRefusal;
  }
  return `${standDown.reason}: ${standDown.tokensUsed} of ${standDown.spendable} tokens used, resets ${standDown.resetsAt.toISOString()}`;
}
