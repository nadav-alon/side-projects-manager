import type { StandDown } from "./budget-gate.ts";
import { pullRequestResolutionPhrase } from "./close-comment.ts";
import type { Discard, HandBackRecord } from "./hand-back.ts";
import { workLocation } from "./hand-back.ts";
import {
  handedBackAheadOfGate,
  handedBackFailure,
  type AppliedReview,
  type Attempt,
  type CutOff,
  type Failed,
  type Finished,
  type Handover,
  type IterationOutcome,
  type NotClosed,
  type NotCommented,
  type NotLabelled,
  type PullRequestResolved,
  type Rebased,
  type Reviewed,
} from "./iteration-outcome.ts";
import type { InvocationStandDown } from "./morning-run.ts";
import type { ProjectOutcome, ProjectVerdict } from "./selection.ts";
import type {
  ApplyReviewTicket,
  PullRequestLabel,
  PullRequestTicket,
  PullRequestUrl,
  RebaseTicket,
  RepoSlug,
  ReviewTicket,
  RunFinished,
  Salvaged,
  Size,
  Ticket,
  TokenCount,
  TranscriptPath,
} from "./ports/index.ts";
import {
  APPLIED_REVIEW_LABEL,
  APPLY_REVIEW_COMMENT,
  NEEDS_REBASE_LABEL,
  READY_FOR_AGENT_LABEL,
  READY_FOR_HUMAN_LABEL,
  REVIEWED_LABEL,
  declaredSize,
  isRebaseTicket,
  isReviewTicket,
  localDay,
  localTimeOfMinute,
} from "./ports/index.ts";

/** How a verdict reads to the developer. A selected project was not skipped. */
function skipReason(verdict: ProjectVerdict): string | undefined {
  switch (verdict) {
    case "paused":
      return "paused";
    case "no-eligible-tickets":
      return "no ready-for-agent tickets";
    case "already-worked-today":
      return "already worked today";
    case "deferred":
      return "outranked this morning";
    case "selected":
      return undefined;
  }
}

/**
 * Names every ticket a scan passed over for being a supertask or blocked,
 * whatever its project's verdict: a project can be selected for one ticket
 * while another in its backlog is passed over, and a backlog that looks full
 * but yields nothing is only explicable if the summary says so.
 */
function passedOverAside(projects: ProjectOutcome[]): string {
  const passedOver = projects.flatMap(({ repo, supertasks, blocked }) => {
    const reasons = [
      ...(supertasks === undefined
        ? []
        : [`${numbers(supertasks)} broken out into sub-issues`]),
      ...(blocked === undefined
        ? []
        : [`${numbers(blocked)} blocked by an open ticket`]),
    ];
    return reasons.length > 0 ? [`${repo} (${reasons.join("; ")})`] : [];
  });
  return passedOver.length > 0 ? ` Passed over ${passedOver.join(", ")}.` : "";
}

/** Tickets as the summary names them: `#1, #2`. */
function numbers(tickets: Ticket[]): string {
  return tickets.map((ticket) => `#${ticket.number}`).join(", ");
}

/**
 * An error or reason, trimmed of trailing whitespace and then of at most one
 * trailing `.` it already ends with. Every call site interpolates this
 * either right before punctuation of its own, mid-sentence before more text,
 * or at the end of a bullet joined with others by `\n`; an error that
 * already ends in a period would otherwise read as `..` next to that
 * punctuation, and one ending in a newline would otherwise break the line
 * ahead of the rest of the sentence, or split a bullet list in two. Strips
 * only one trailing `.`, not a whole run, so a reason ending in an ellipsis
 * keeps it.
 */
function withoutTrailingStop(text: string): string {
  return text.trim().replace(/\.$/, "");
}

/**
 * Everything the summary is built from: the outcome of every registered
 * project, every attempt this invocation made, why it stood down, if it did,
 * and whether the invocation itself broke before finishing. One type rather
 * than four parameters, since `summaryLine` and `summaryBody` both need
 * exactly these facts and nothing else.
 */
export interface SummaryFacts {
  projects: ProjectOutcome[];
  iterations: IterationOutcome[];
  standDown: InvocationStandDown | undefined;
  invocationFailure: string | undefined;
}

/** The summary in one line: the invocation's `message`, and the body's opening. */
export function summaryLine(facts: SummaryFacts): string {
  if (facts.invocationFailure !== undefined) {
    return `The invocation did not finish: ${withoutTrailingStop(facts.invocationFailure)}.`;
  }

  const { projects, iterations, standDown } = facts;
  const skipped = projects.flatMap((project) => {
    const reason = skipReason(project.verdict);
    return reason === undefined ? [] : [`${project.repo} (${reason})`];
  });

  const passedOver = passedOverAside(projects);
  const aside = `${skipped.length > 0 ? ` Skipped ${skipped.join(", ")}.` : ""}${passedOver}`;

  if (iterations.length > 0) {
    // A stand-down after the morning had already done some good is said after
    // what was worked, since the developer still needs both.
    const worked = iterations.map(describeIteration).join(" ");
    const stopped =
      standDown === undefined
        ? ""
        : ` Stood down after that: ${whyStoodDown(standDown, "next")}`;
    return `${worked}${stopped}${aside}`;
  }
  // The gate refused before a single run this morning: there is work waiting,
  // named by the project the gate turned away, but none of it ran.
  if (standDown !== undefined) {
    return `Stood down: ${whyStoodDown(standDown, "first")}${aside}`;
  }
  if (skipped.length === 0) {
    return "Nothing to do: no projects registered. Add one to registry.json (see README).";
  }
  return `Nothing to do: skipped ${skipped.join(", ")}.${passedOver}`;
}

/**
 * Why the invocation stood down, and what that left waiting. The gate names
 * the project it turned away and when the window resets; a limit refusal
 * names the ticket it refused, which is still eligible, and quotes the reset
 * the provider gave. A provider failure, as a limit refusal, names the ticket
 * it stopped and quotes what the provider said. A developer's stop names
 * nothing: they already know why.
 *
 * `when` is whether any run came before the stand-down, which only changes
 * how the gate's refused project, or a developer's stop, is introduced.
 */
function whyStoodDown(
  standDown: InvocationStandDown,
  when: "first" | "next",
): string {
  if (standDown.reason === "stopped") {
    return when === "next"
      ? "stopped by hand, so nothing further started."
      : "stopped by hand before any run started.";
  }
  if (standDown.reason === "provider-limit" || standDown.reason === "provider-failure") {
    const { ticket } = standDown;
    const said =
      standDown.reason === "provider-limit"
        ? withoutTrailingStop(standDown.limitRefusal)
        : `a provider failure stopped it: ${withoutTrailingStop(standDown.providerFailure)}`;
    return `${said}. ${ticket.repo} #${ticket.number} is still ${READY_FOR_AGENT_LABEL} and will come round again.`;
  }
  const ready =
    when === "next" ? "was ready to work next" : "was ready to work";
  return `${standDownReason(standDown)}. ${standDown.refused} ${ready}; the window resets ${standDown.resetsAt.toISOString()}.`;
}

/**
 * The summary issue's title: dated to the local day, with the local time to
 * the minute beside it, so a firing every hour still reads in order rather
 * than several summaries sharing one indistinguishable title.
 */
export function summaryTitle(startedAt: Date): string {
  return `Morning loop summary — ${localDay(startedAt)} ${localTimeOfMinute(startedAt)}`;
}

/**
 * `startedAt` as the filename a kept summary is written under: the same
 * local day and time to the minute as its title, so a developer finding it
 * in the manager home does not have to do offset arithmetic to match it back
 * to the morning it came from. The colon is filesystem-unsafe, so it is
 * swapped for a dash.
 */
export function summaryFileName(startedAt: Date): string {
  return `summary-${localDay(startedAt)}T${localTimeOfMinute(startedAt).replace(":", "-")}.txt`;
}


/**
 * The summary issue's body: CONTEXT.md's "Summary" entry, written out in
 * full. `message` stays the one line a terminal or a trigger's own log wants;
 * this is the fuller account — every attempt with its cost, and what is now
 * waiting on the developer — the issue itself carries. `line` is passed in
 * rather than recomputed from `facts`: the caller already built it for
 * `message`, and it reads the same either way.
 */
export function summaryBody(facts: SummaryFacts, line: string): string {
  return [
    line,
    facts.iterations.length === 0
      ? undefined
      : attemptsSection(facts.iterations),
    waitingSection(facts.iterations, facts.projects),
  ]
    .filter((section): section is string => section !== undefined)
    .join("\n\n");
}

/**
 * One bullet per attempt this invocation made, its outcome, its cost beside
 * its run estimate, and the model it was started on. An attempt that started
 * no run names neither.
 */
function attemptsSection(iterations: IterationOutcome[]): string {
  const lines = iterations.map((iteration) => {
    if (ranNothing(iteration)) {
      return `- ${describeIteration(iteration)} — nothing run`;
    }
    return `- ${describeIteration(iteration)}${costClause(iteration)} on ${iteration.model ?? "the image's model"}`;
  });
  return ["## Attempts", ...lines].join("\n");
}

/**
 * What a worked iteration's cost reads as: unknown when nothing recorded it,
 * beside the run estimate the gate charged, or — when it spent past that
 * estimate — the same, flagged with the ticket's own size label, or
 * "unsized" where it names none, so the developer knows whether to raise the
 * ticket's own size in the budget document or, for "unsized", the size
 * `unsizedCountsAs` names there. Per `CONTEXT.md`'s "Run estimate": nothing
 * here revises the estimate itself.
 */
function costClause(iteration: IterationOutcome): string {
  const spent = iteration.tokensUsed;
  if (spent === undefined) {
    return " — cost unknown";
  }
  const estimate = iteration.estimateCharged;
  if (estimate === undefined) {
    return ` — ${tokens(spent)} tokens`;
  }
  const beside = `${tokens(spent)} / ${tokens(estimate)} tokens`;
  return spent > estimate
    ? ` — ${beside}, over its ${sizeFlag(iteration.ticket)} estimate`
    : ` — ${beside}`;
}

/**
 * The size `ticket` reads as to the developer: its own declared size, or
 * "unsized" — never a pull request ticket's own size label, which is read
 * but never counted, per `CONTEXT.md`'s "Size label".
 */
function sizeFlag(ticket: Ticket): Size | "unsized" {
  return declaredSize(ticket) ?? "unsized";
}

/** A ticket whose hand-back itself failed: still eligible, still waiting on a human to relabel it by hand. */
function stillEligibleLine(iteration: {
  repo: RepoSlug;
  ticket: Ticket;
}): string {
  return `- ${iteration.repo} #${iteration.ticket.number}: still ${READY_FOR_AGENT_LABEL} — the hand-back itself failed, relabel it yourself`;
}

/** What the developer may want to do about a ticket that keeps getting cut off — said the same way everywhere it comes up. */
const CONSIDER_SPLITTING = "consider splitting it or giving it a larger size or model";

/** A limit-refused ticket whose salvage shows it has been cut off repeatedly: worth the developer's attention, since it may need splitting or a larger size or model. */
function repeatedRefusalWaitingLine(
  iteration: { repo: RepoSlug; ticket: Ticket },
  limitRefusals: number,
): string {
  return `- ${iteration.repo} #${iteration.ticket.number}: cut off ${limitRefusals} times in a row — ${CONSIDER_SPLITTING}`;
}

/**
 * What now needs the developer: a draft pull request to review, a ticket
 * relabelled for human attention, a setup that broke under a ticket it left
 * eligible, or — the one case a failed run can leave behind that is the
 * developer's alone, per `HandBackRecord`'s `"refused"` outcome — a ticket the
 * hand-back itself could not reach, still eligible and due to come round
 * again until somebody relabels it by hand. A review the loop could not
 * close is there for the same reason, as is a reviewed or applied-review
 * ticket whose pull request closed cleanly but could not be labelled: the
 * label is the developer's to add by hand. A project whose backlog was too
 * long to read in full belongs here too, in registry order, since thinning
 * it is the developer's to do regardless of what else the morning found.
 */
function waitingSection(
  iterations: IterationOutcome[],
  projects: ProjectOutcome[],
): string | undefined {
  const reviewOutcomes = workedReviewOutcomes(iterations);
  const iterationLines = iterations.flatMap((iteration): string[] => {
    switch (iteration.kind) {
      case "reviewed": {
        if (reviewLeftOpen(iteration)) {
          return [notClosedLine(iteration, iteration.notClosed)];
        }
        return [
          ...(iteration.notLabelled === undefined
            ? []
            : [notLabelledLine(iteration, REVIEWED_LABEL, iteration.notLabelled)]),
          ...(iteration.notCommented === undefined
            ? []
            : [notCommentedLine(iteration, iteration.notCommented)]),
        ];
      }
      case "applied-review": {
        const waiting = appliedReviewWaitingLine(iteration);
        if (!appliedReviewNotLabelled(iteration)) {
          return [waiting];
        }
        return [
          waiting,
          notLabelledLine(iteration, APPLIED_REVIEW_LABEL, iteration.notLabelled),
        ];
      }
      case "rebased":
        return [rebasedWaitingLine(iteration)];
      // Closed outright, so nothing here waits on the developer — unless the
      // close itself failed, which leaves the ticket eligible and waiting the
      // same way a review or a rebase left open does.
      case "pull-request-resolved":
        return iteration.notClosed === undefined
          ? []
          : [pullRequestResolvedWaitingLine(iteration, iteration.notClosed)];
      // A limit refusal's or a provider failure's ticket waits on the
      // provider, not the developer — unless a limit refusal's salvage shows
      // the ticket has been cut off repeatedly, which the developer may want
      // to act on by splitting it or giving it a larger size or model.
      case "limit-refused": {
        const salvage = salvageOf(iteration.discard);
        return salvage !== undefined && salvage.limitRefusals >= 2
          ? [repeatedRefusalWaitingLine(iteration, salvage.limitRefusals)]
          : [];
      }
      case "provider-failed":
        return [];
      case "failed":
        return waitingOnFailure(iteration);
      case "finished": {
        // A finished run's own hand-back, covering the two cases a queued
        // review does not: a run that committed nothing, which has nothing to
        // name but the relabel itself, and a run whose hand-back — of either
        // kind — was refused by the tracker. A ticket an overlapping run had
        // already closed needs neither: it was left exactly as it found it.
        const { handover, handedBack } = iteration;
        return [
          ...(handover === undefined
            ? []
            : handoverLines(
                iteration.repo,
                handover,
                reviewOutcomes.get(reviewKey(iteration.repo, handover)),
              )),
          ...(handedBack.outcome === "refused"
            ? [stillEligibleLine(iteration)]
            : handover === undefined && handedBack.outcome !== "already-closed"
              ? [
                  `- ${iteration.repo} #${iteration.ticket.number}: relabelled ${READY_FOR_HUMAN_LABEL} — the run committed nothing`,
                ]
              : []),
        ];
      }
    }
  });

  const backlogLines = projects.flatMap((project) =>
    project.backlogTruncated === undefined
      ? []
      : [backlogTruncatedLine(project.repo)],
  );

  const bullets = [...iterationLines, ...backlogLines];
  return bullets.length === 0
    ? undefined
    : ["## Waiting on you", ...bullets].join("\n");
}

/** A backlog too long to read in full: the bullet names the project, since the tickets it left unread are too many to name. */
function backlogTruncatedLine(repo: RepoSlug): string {
  return `- ${repo}: holds more than 100 ${READY_FOR_AGENT_LABEL} tickets — only the newest 100 were considered`;
}

/** Keys a ticket by its repo and number, to correlate it across iterations. */
function ticketKey(repo: RepoSlug, number: number): string {
  return `${repo}#${number}`;
}

/** Keys a review ticket by its repo and number, to look it up across iterations. */
function reviewKey(repo: RepoSlug, handover: Handover): string {
  return ticketKey(repo, handover.reviewTicket.number);
}

/**
 * Every iteration this invocation itself worked a review ticket's own run,
 * keyed by repo and ticket number, so a finished run's handover line can tell
 * whether its queued review already ran. Excludes every outcome that leaves
 * the review ticket untouched: a limit refusal, and an infrastructure
 * failure, which never starts a run and is never handed back.
 */
function workedReviewOutcomes(
  iterations: IterationOutcome[],
): Map<string, IterationOutcome> {
  const outcomes = new Map<string, IterationOutcome>();
  for (const iteration of iterations) {
    if (!isReviewTicket(iteration.ticket)) {
      continue;
    }
    if (
      iteration.kind === "reviewed" ||
      iteration.kind === "pull-request-resolved" ||
      (iteration.kind === "failed" && iteration.failure.kind !== "infrastructure")
    ) {
      outcomes.set(ticketKey(iteration.repo, iteration.ticket.number), iteration);
    }
  }
  return outcomes;
}

/**
 * The Waiting-on-you lines for a finished run's handover: zero or one. A
 * review not yet worked this invocation is still queued, the same as one an
 * overlapping run closed out from under before this invocation's own attempt
 * on it could do anything — its own case names nothing for a ticket it found
 * already closed, so the queued pull request would otherwise vanish with it.
 * One that ran and closed its ticket cleanly needs a line here naming the
 * pull request as reviewed: the `reviewed` case adds nothing of its own for
 * that outcome, except — when the label itself failed — its own line about
 * the label rather than the review, so the two stand as separate lines
 * rather than one repeating the other. One that failed some other way, ran
 * but could not close its ticket, or closed instead of running because its
 * own pull request had already resolved, already has its own line — or none
 * — from that iteration's own case, so nothing is added here — a second line
 * would only repeat it.
 */
function handoverLines(
  repo: RepoSlug,
  handover: Handover,
  reviewOutcome: IterationOutcome | undefined,
): string[] {
  if (
    reviewOutcome === undefined ||
    (reviewOutcome.kind === "failed" &&
      handedBackFailure(reviewOutcome) &&
      reviewOutcome.handedBack.outcome === "already-closed")
  ) {
    return [
      `- ${repo}: ${handover.pullRequest} — review queued as #${handover.reviewTicket.number}`,
    ];
  }
  if (reviewOutcome.kind === "reviewed" && !reviewLeftOpen(reviewOutcome)) {
    return [`- ${repo}: ${handover.pullRequest} — reviewed, findings posted`];
  }
  return [];
}

/**
 * Whether a review ticket's own run left its ticket open, with something
 * still left for the developer to do. Read both at the review's own case in
 * `waitingSection` and at `handoverLines`'s lookup of that same outcome by
 * the run that queued it — the two describe the same fact and must stay
 * exact inverses of each other.
 */
function reviewLeftOpen(
  outcome: Reviewed,
): outcome is Reviewed & { notClosed: NotClosed } {
  return outcome.notClosed !== undefined;
}

/**
 * Whether an applied-review iteration's ticket closed cleanly but its pull
 * request could not be labelled — labelling is tried only once the ticket
 * has closed, so this and `notClosed` never both hold.
 */
function appliedReviewNotLabelled(
  outcome: AppliedReview,
): outcome is AppliedReview & { notLabelled: NotLabelled } {
  return outcome.notClosed === undefined && outcome.notLabelled !== undefined;
}

/**
 * What a failed run leaves waiting on the developer. Empty for a ticket an
 * overlapping run closed first: hand-back left it exactly as it found it, so
 * there is nothing here for the developer to do.
 */
function waitingOnFailure(iteration: Attempt & Failed): string[] {
  const { repo, ticket } = iteration;
  if (!handedBackFailure(iteration)) {
    return [
      `- ${repo} #${ticket.number}: still ${READY_FOR_AGENT_LABEL} — the sandbox or checkout failed, so fix the setup: ${withoutTrailingStop(iteration.failure.reason)}`,
    ];
  }
  const { failure, handedBack } = iteration;
  if (handedBack.outcome === "already-closed") {
    return [];
  }
  if (handedBack.outcome === "refused") {
    return [stillEligibleLine({ repo, ticket })];
  }
  switch (failure.kind) {
    case "gave-up":
      return [`- ${repo} #${ticket.number}: relabelled ${READY_FOR_HUMAN_LABEL}`];
    case "handover-failed":
      return [
        `- ${repo} #${ticket.number}: relabelled ${READY_FOR_HUMAN_LABEL} — its work is on ${workLocation(failure)}, but ${withoutTrailingStop(failure.reason)}`,
      ];
    case "model-refused":
      return [
        `- ${repo} #${ticket.number}: relabelled ${READY_FOR_HUMAN_LABEL} — the model ${failure.refusal.model} was refused, so fix the ${failure.source}`,
      ];
    case "unsettled-mergeability":
      return [
        `- ${repo} #${ticket.number}: relabelled ${READY_FOR_HUMAN_LABEL} — its pull request's mergeability never settled, so check whether it is still open`,
      ];
    case "conflicting-model-labels":
    case "unusable-model-label":
      return [
        `- ${repo} #${ticket.number}: relabelled ${READY_FOR_HUMAN_LABEL} — fix its model labels (${failure.labels.join(", ")})`,
      ];
    case "unusable-size-label":
      return [
        `- ${repo} #${ticket.number}: relabelled ${READY_FOR_HUMAN_LABEL} — fix its size label (${failure.labels.join(", ")})`,
      ];
  }
}

/**
 * Whether `iteration` started no run: a ticket handed back before one could
 * start, or a pull request ticket that found nothing to do. A switch on every
 * kind, so an iteration kind added later has to say which it is.
 */
function ranNothing(iteration: IterationOutcome): boolean {
  switch (iteration.kind) {
    case "applied-review":
      return iteration.review === undefined;
    case "rebased":
      return iteration.rebase === undefined;
    case "pull-request-resolved":
      return true;
    case "failed":
      return (
        handedBackAheadOfGate(iteration) ||
        iteration.failure.kind === "unsettled-mergeability"
      );
    case "finished":
    case "reviewed":
    case "limit-refused":
    case "provider-failed":
      return false;
  }
}

/** What a cut-off iteration says about a branch its discard could not throw away. Empty when there was none, or it went cleanly. */
function keptBranchNote(iteration: CutOff): string {
  return iteration.discard.kind === "kept"
    ? ` Its branch ${iteration.run?.branch ?? ""} could not be discarded: ${withoutTrailingStop(iteration.discard.reason)}.`
    : "";
}

/** `discard`'s salvage, when it is one — undefined for every other `Discard` kind. */
function salvageOf(discard: Discard): Salvaged | undefined {
  return discard.kind === "salvaged" ? discard : undefined;
}

/**
 * The clause a cut-off iteration's line adds when its branch was salvaged:
 * naming it, and that the ticket's next run will continue on it — see
 * CONTEXT.md's "Salvage". Empty when nothing was salvaged.
 */
function salvagedBranchNote(salvage: Salvaged | undefined): string {
  return salvage === undefined
    ? ""
    : ` Its branch ${salvage.branch} was salvaged: the ticket's next run will continue on it.`;
}

/**
 * `salvagedBranchNote`, plus — for a limit refusal only — a warning once its
 * ticket's own count of limit refusals in a row reaches two, since that is
 * worth splitting it or giving it a larger size or model over; at exactly one
 * it stays quiet, a single refusal being unremarkable. An infrastructure
 * failure never adds the warning here: its own `limitRefusals` only ever
 * repeats what an earlier limit refusal already recorded, so this line's
 * count would not be its own (see `InfrastructureFailure.salvage`).
 */
function salvageNote(salvage: Salvaged | undefined): string {
  if (salvage === undefined) {
    return "";
  }
  const kept = salvagedBranchNote(salvage);
  return salvage.limitRefusals < 2
    ? kept
    : `${kept} This ticket has been cut off ${salvage.limitRefusals} times in a row: ${CONSIDER_SPLITTING}.`;
}

/**
 * The transcript a run left, said as its own clause — empty when none was
 * found. The ticket this reports for (#409): after any sandboxed run exits,
 * its session transcript exists on the host, and the run's own outcome or
 * summary says where — this is the summary half of that.
 */
function transcriptNote(transcript: TranscriptPath | undefined): string {
  return transcript === undefined ? "" : ` Transcript: ${transcript}.`;
}

/** One line for one iteration: what it landed, why it did not finish, or what it found. */
function describeIteration(iteration: IterationOutcome): string {
  switch (iteration.kind) {
    case "limit-refused":
      return `The provider limit refused the run on ${iteration.repo} #${iteration.ticket.number}.${keptBranchNote(iteration)}${salvageNote(salvageOf(iteration.discard))}${transcriptNote(iteration.transcript)}`;
    case "provider-failed":
      return `A provider failure stopped the run on ${iteration.repo} #${iteration.ticket.number}: ${withoutTrailingStop(iteration.providerFailure)}.${keptBranchNote(iteration)}${transcriptNote(iteration.transcript)}`;
    case "failed": {
      const { repo, ticket } = iteration;
      // Named as a rebase, since a rebase ticket's own title says nothing a
      // reader of the summary would tell apart from an apply-review's.
      const attempted = isRebaseTicket(ticket)
        ? `a rebase of ${ticket.pullRequest.url} on ${repo}`
        : repo;
      return `Attempted ${attempted}: ${stoppedBecause(iteration)}${transcriptNote(iteration.transcript)}`;
    }
    case "reviewed":
      return `${reviewSummary(iteration)}${transcriptNote(iteration.review.transcript)}`;
    case "applied-review":
      return `${appliedReviewSummary(iteration)}${transcriptNote(iteration.review?.transcript)}`;
    case "rebased":
      return `${rebasedSummary(iteration)}${transcriptNote(iteration.rebase?.transcript)}`;
    case "pull-request-resolved":
      return pullRequestResolvedSummary(iteration);
    case "finished":
      return `Worked ${iteration.repo}: ${landed(iteration)}.${queued(iteration)}${handbackNote(iteration)}${transcriptNote(iteration.run.transcript)}`;
  }
}

/**
 * Says when a finished run's own hand-back — the relabel that takes its
 * ticket out of the queue — was refused. Empty when it succeeded, since
 * `landed` and `queued` already say what became of the run itself, and a
 * ticket successfully handed back needs nothing more said about it here.
 *
 * Reads through `handedBackNow`, the same function a failed iteration's own
 * `stoppedBecause` reads, so a refused hand-back is said one way rather than
 * in two wordings that drift apart from each other.
 */
function handbackNote(finished: Finished): string {
  return finished.handedBack.outcome !== "refused"
    ? ""
    : ` ${handedBackNow("The ticket", finished.handedBack)}`;
}

/**
 * How a review ticket's own run reads to the developer: where its findings
 * landed, or why the loop could not finish the ticket off.
 */
function reviewSummary(
  iteration: { repo: RepoSlug; ticket: ReviewTicket } & Reviewed,
): string {
  const { repo, ticket, notClosed, notLabelled, notCommented } = iteration;
  switch (notClosed?.kind) {
    case undefined: {
      const posted = `Reviewed ${repo} #${ticket.number}: posted findings on ${ticket.pullRequest.url}.`;
      const labelNote =
        notLabelled === undefined
          ? ""
          : ` ${notLabelledNote(ticket.pullRequest.url, REVIEWED_LABEL, notLabelled)}.`;
      const commentNote =
        notCommented === undefined
          ? ""
          : ` ${notCommentedNote(ticket.pullRequest.url, notCommented)}.`;
      return `${posted}${labelNote}${commentNote}`;
    }
    case "check-failed":
      return `Reviewed ${repo} #${ticket.number}, but ${ticket.pullRequest.url} could not be checked for its findings: ${withoutTrailingStop(notClosed.error)}. Still ${READY_FOR_AGENT_LABEL}: check ${ticket.pullRequest.url} and close it yourself.`;
    case "close-failed":
      return `Reviewed ${repo} #${ticket.number}: posted findings on ${ticket.pullRequest.url}, but the ticket could not be closed: ${withoutTrailingStop(notClosed.error)}. Still ${READY_FOR_AGENT_LABEL}: close it yourself.`;
  }
}

/**
 * The sentence a failed label reads as, wherever it is said: read at
 * `notLabelledLine`, and inline at the end of `reviewSummary` and
 * `appliedReviewSummary`'s own clean-outcome sentence — so a refused label is
 * said one way rather than in three wordings that drift apart from each
 * other.
 */
function notLabelledNote(
  pullRequest: PullRequestUrl,
  label: PullRequestLabel,
  { error }: NotLabelled,
): string {
  return `${pullRequest} could not be labelled ${label}: ${withoutTrailingStop(error)}; add the label yourself`;
}

/**
 * The Waiting-on-you line for a review or apply-review iteration whose ticket
 * closed but whose pull request could not be labelled `label`. Read at both
 * kinds' own case in `waitingSection`, once each has ruled out `notClosed`:
 * labelling is tried only after the ticket has already closed, so the two
 * never both apply to the same iteration.
 */
function notLabelledLine(
  { repo, ticket }: { repo: RepoSlug; ticket: PullRequestTicket },
  label: PullRequestLabel,
  notLabelled: NotLabelled,
): string {
  return `- ${repo} #${ticket.number}: ${notLabelledNote(ticket.pullRequest.url, label, notLabelled)}`;
}

/**
 * The sentence a turbo project's refused comment reads as, wherever it is
 * said: read at `notCommentedLine`, and inline at the end of `reviewSummary`'s
 * clean-outcome sentence — so a refused comment is said one way rather than
 * in two wordings that drift apart from each other. CONTEXT.md's "Turbo",
 * ADR 0006.
 */
function notCommentedNote(
  pullRequest: PullRequestUrl,
  { error }: NotCommented,
): string {
  return `${pullRequest} could not be posted ${APPLY_REVIEW_COMMENT} on: ${withoutTrailingStop(error)}; comment it yourself`;
}

/**
 * The Waiting-on-you line for a turbo review iteration whose closed ticket's
 * pull request could not be commented on. Read at the `reviewed` case in
 * `waitingSection`, once it has ruled out `notClosed`: the comment is tried
 * only after the ticket has already closed, so the two never both apply to
 * the same iteration.
 */
function notCommentedLine(
  { repo, ticket }: { repo: RepoSlug; ticket: ReviewTicket },
  notCommented: NotCommented,
): string {
  return `- ${repo} #${ticket.number}: ${notCommentedNote(ticket.pullRequest.url, notCommented)}`;
}

/** The Waiting-on-you line for a review that ran but left its ticket open. */
function notClosedLine(
  { repo, ticket }: { repo: RepoSlug; ticket: ReviewTicket },
  notClosed: NotClosed,
): string {
  const still = `- ${repo} #${ticket.number}: still ${READY_FOR_AGENT_LABEL}`;
  switch (notClosed.kind) {
    case "check-failed":
      return `${still} — ${ticket.pullRequest.url} could not be checked for its findings: ${withoutTrailingStop(notClosed.error)}; check it and close the ticket yourself`;
    case "close-failed":
      return `${still} — its findings are on ${ticket.pullRequest.url}, but it could not be closed: ${withoutTrailingStop(notClosed.error)}; close it yourself`;
  }
}

/** An apply-review iteration, with the ticket it worked. */
type AppliedReviewIteration = Attempt<ApplyReviewTicket> & AppliedReview;

/** What the replies came to on the pull request, or that there were none to post. */
function answered({ ticket, answers }: AppliedReviewIteration): string {
  const pullRequest = ticket.pullRequest.url;
  return answers === undefined
    ? `nothing left to apply on ${pullRequest}`
    : `${answers.applied} applied, ${answers.declined} declined on ${pullRequest}`;
}

/**
 * How an apply-review ticket's iteration reads to the developer: what it
 * applied and declined and that the pull request is ready for review, or why
 * the loop could not finish the ticket off.
 */
function appliedReviewSummary(iteration: AppliedReviewIteration): string {
  const { repo, ticket, notClosed, notLabelled } = iteration;
  const pullRequest = ticket.pullRequest.url;
  const applied = `Applied review on ${repo} #${ticket.number}`;
  switch (notClosed?.kind) {
    case undefined: {
      const ready = `${applied}: ${answered(iteration)}, now ready for review.`;
      return notLabelled === undefined
        ? ready
        : `${ready} ${notLabelledNote(pullRequest, APPLIED_REVIEW_LABEL, notLabelled)}.`;
    }
    case "check-failed":
      return `${applied}, but ${pullRequest} could not be checked for its answers: ${withoutTrailingStop(notClosed.error)}. Still ${READY_FOR_AGENT_LABEL}, and ${pullRequest} still a draft: check it, mark it ready and close the ticket yourself.`;
    case "ready-failed":
      return `${applied}: ${answered(iteration)}, but it could not be marked ready for review: ${withoutTrailingStop(notClosed.error)}. Still ${READY_FOR_AGENT_LABEL}: mark ${pullRequest} ready and close the ticket yourself.`;
    case "close-failed":
      return `${applied}: ${answered(iteration)}, now ready for review, but the ticket could not be closed: ${withoutTrailingStop(notClosed.error)}. Still ${READY_FOR_AGENT_LABEL}: close it yourself.`;
  }
}

/** The Waiting-on-you line for an apply-review iteration: its pull request to review, or the ticket left open. */
function appliedReviewWaitingLine(iteration: AppliedReviewIteration): string {
  const { repo, ticket, notClosed } = iteration;
  const pullRequest = ticket.pullRequest.url;
  const still = `- ${repo} #${ticket.number}: still ${READY_FOR_AGENT_LABEL}`;
  switch (notClosed?.kind) {
    case undefined:
      return `- ${repo}: ${pullRequest} — ready for review`;
    case "check-failed":
      return `${still} — ${pullRequest} could not be checked for its answers: ${withoutTrailingStop(notClosed.error)}; check it, mark it ready and close the ticket yourself`;
    case "ready-failed":
      return `${still} — ${pullRequest} could not be marked ready for review: ${withoutTrailingStop(notClosed.error)}; mark it ready and close the ticket yourself`;
    case "close-failed":
      return `${still} — ${pullRequest} is ready for review, but the ticket could not be closed: ${withoutTrailingStop(notClosed.error)}; close it yourself`;
  }
}

/** A rebase iteration, with the ticket it worked. */
type RebasedIteration = Attempt<RebaseTicket> & Rebased;

/** What became of the pull request: rebased by the run, or already on its base. */
function rebasedWhat({ repo, ticket, rebase }: RebasedIteration): string {
  const pullRequest = ticket.pullRequest.url;
  return rebase === undefined
    ? `Nothing to rebase for ${repo} #${ticket.number}: ${pullRequest} already sits on its base`
    : `Rebased ${pullRequest} for ${repo} #${ticket.number}`;
}

/**
 * How a rebase ticket's iteration reads to the developer: that its pull
 * request no longer conflicts, or why the loop could not finish the ticket
 * off. Nothing is said of its draft state, which a rebase leaves alone.
 */
function rebasedSummary(iteration: RebasedIteration): string {
  const { ticket, rebase, notClosed } = iteration;
  const pullRequest = ticket.pullRequest.url;
  const what = rebasedWhat(iteration);
  const clean =
    rebase === undefined ? what : `${what}: it no longer conflicts with its base`;
  switch (notClosed?.kind) {
    case undefined:
      return `${clean}.`;
    case "check-failed":
      return `${what}, but ${pullRequest} could not be checked for conflicts: ${withoutTrailingStop(notClosed.error)}. Still ${READY_FOR_AGENT_LABEL}: check it and close the ticket yourself.`;
    case "label-failed":
      return `${clean}, but ${NEEDS_REBASE_LABEL} could not be taken off it: ${withoutTrailingStop(notClosed.error)}. Still ${READY_FOR_AGENT_LABEL}: take the label off and close the ticket yourself.`;
    case "close-failed":
      return `${clean}, but the ticket could not be closed: ${withoutTrailingStop(notClosed.error)}. Still ${READY_FOR_AGENT_LABEL}: close it yourself.`;
  }
}

/** The Waiting-on-you line for a rebase iteration: its pull request to merge, or the ticket left open. */
function rebasedWaitingLine(iteration: RebasedIteration): string {
  const { repo, ticket, rebase, notClosed } = iteration;
  const pullRequest = ticket.pullRequest.url;
  const still = `- ${repo} #${ticket.number}: still ${READY_FOR_AGENT_LABEL}`;
  switch (notClosed?.kind) {
    case undefined:
      return rebase === undefined
        ? `- ${repo}: ${pullRequest} — already on its base`
        : `- ${repo}: ${pullRequest} — rebased onto its base`;
    case "check-failed":
      return `${still} — ${pullRequest} could not be checked for conflicts: ${withoutTrailingStop(notClosed.error)}; check it and close the ticket yourself`;
    case "label-failed":
      return `${still} — ${NEEDS_REBASE_LABEL} could not be taken off ${pullRequest}: ${withoutTrailingStop(notClosed.error)}; take it off and close the ticket yourself`;
    case "close-failed":
      return `${still} — ${pullRequest} no longer conflicts, but the ticket could not be closed: ${withoutTrailingStop(notClosed.error)}; close it yourself`;
  }
}

/** A pull request ticket iteration, with the ticket it worked. */
type PullRequestResolvedIteration = Attempt<PullRequestTicket> &
  PullRequestResolved;

/**
 * How a pull request ticket's iteration reads to the developer when its own
 * pull request was already merged or closed: closed with no run, or why the
 * loop could not close it.
 */
function pullRequestResolvedSummary(
  iteration: PullRequestResolvedIteration,
): string {
  const { repo, ticket, resolution, notClosed } = iteration;
  const pullRequest = ticket.pullRequest.url;
  const what = pullRequestResolutionPhrase(resolution);
  if (notClosed === undefined) {
    return `Closed ${repo} #${ticket.number}: ${pullRequest} was already ${what}, so no run started.`;
  }
  return `${repo} #${ticket.number}: ${pullRequest} was already ${what}, but the ticket could not be closed: ${withoutTrailingStop(notClosed.error)}. Still ${READY_FOR_AGENT_LABEL}: close it yourself.`;
}

/** The Waiting-on-you line for a pull request ticket the loop found already resolved but could not close. */
function pullRequestResolvedWaitingLine(
  { repo, ticket }: PullRequestResolvedIteration,
  notClosed: NotClosed & { kind: "close-failed" },
): string {
  return `- ${repo} #${ticket.number}: still ${READY_FOR_AGENT_LABEL} — its pull request is already resolved, but the ticket could not be closed: ${withoutTrailingStop(notClosed.error)}; close it yourself`;
}

/**
 * The review waiting on the developer, named by number because that is how a
 * backlog is read. Nothing to say on a morning that opened no pull request,
 * which is the only morning that queues no review.
 */
function queued(finished: Finished): string {
  const review = finished.handover?.reviewTicket;
  return review === undefined ? "" : ` Queued #${review.number} to review it.`;
}

/**
 * The clause naming what became of a failed ticket's own hand-back: handed
 * back for a human, left alone because an overlapping run had already closed
 * it, or still eligible because the hand-back itself failed.
 */
function handedBackNow(which: string, handedBack: HandBackRecord): string {
  switch (handedBack.outcome) {
    case "handed-back":
      return "Handed back for a human.";
    case "already-closed":
      return `${which} was already closed by another run, so it was left alone.`;
    case "refused":
      return `${which} is still ${READY_FOR_AGENT_LABEL} and will come round again — the hand-back itself failed: ${withoutTrailingStop(handedBack.reason)}; relabel it yourself.`;
  }
}

/**
 * Why the morning stopped, in the half-sentence the summary carries.
 *
 * Names the ticket, because the developer's next move is to open it: the whole
 * of what happened is in the comment waiting there.
 */
function stoppedBecause(iteration: Attempt & Failed): string {
  const which = `#${iteration.ticket.number}`;
  if (!handedBackFailure(iteration)) {
    const { failure } = iteration;
    const what =
      failure.tokensUsed === undefined
        ? `the run would not start on ${which}`
        : `the sandbox failed on ${which} after the agent had already run`;
    return `${what}: ${withoutTrailingStop(failure.reason)}. ${which} is still ${READY_FOR_AGENT_LABEL}; fix the setup and it will come round again.${salvagedBranchNote(failure.salvage)}`;
  }
  // A ticket that could not be handed back is the one thing here the developer
  // has to act on themselves: it is still eligible, so it will come round and
  // cost another morning until somebody relabels it. One that was already
  // closed needs nothing from them at all: an overlapping run finished it
  // first, and this one's failure is left exactly as it found the ticket.
  const { failure, handedBack } = iteration;
  const now = handedBackNow(which, handedBack);
  switch (failure.kind) {
    case "gave-up":
      return `the agent gave up on ${which}: ${withoutTrailingStop(failure.reason)}. ${now}`;
    case "handover-failed":
      return `${which} finished on ${workLocation(failure)}, but its work could not be handed over: ${withoutTrailingStop(failure.reason)}. ${now}`;
    case "model-refused":
      return `${which} was not worked, because ${withoutTrailingStop(failure.reason)}. ${now}`;
    case "unsettled-mergeability":
    case "conflicting-model-labels":
    case "unusable-model-label":
    case "unusable-size-label":
      return `${which} was not run, because ${withoutTrailingStop(failure.reason)}. ${now}`;
  }
}

/**
 * Where one run's work ended up.
 *
 * A run that committed nothing left no branch behind either — the sandbox
 * keeps one only for commits — so there is nothing to name. A run that failed
 * never gets here: the summary says why it stopped instead.
 */
function landed(finished: Finished): string {
  if (finished.run.commits.length === 0) {
    return "the run left nothing behind";
  }
  const { run, handover } = finished;
  const where =
    handover === undefined
      ? run.branch
      : `${run.branch} (${handover.pullRequest})`;
  return `${commitCount(run)} on ${where}`;
}

/**
 * Why the gate refused, in the developer's terms: what was spent, against
 * what it was measured, which of the two windows said no, and whether
 * consumption alone did it or the run estimate tipped it over.
 */
function standDownReason(standDown: StandDown): string {
  const spent = `${tokens(standDown.tokensUsed)} of ${tokens(standDown.spendable)} tokens`;
  const estimate = `${tokens(standDown.estimateCharged)} tokens charged as the run estimate`;
  switch (standDown.reason) {
    case "weekly-reserve":
      return `spending more of the week would eat into the reserve (${spent} spendable this week)`;
    case "weekly-reserve-estimate":
      return `${spent} spendable this week, but the run estimate (plus any in-progress estimates) would eat into the reserve (${estimate})`;
    case "five-hour-window":
      return `the 5-hour window is spent (${spent})`;
    case "five-hour-window-estimate":
      return `the 5-hour window has ${spent} spent, but the run estimate (plus any in-progress estimates) would spend the rest (${estimate})`;
  }
}

function tokens(count: TokenCount): string {
  return count.toLocaleString("en-US");
}

/** How many commits the run left, said the way a person would say it. */
function commitCount(run: RunFinished): string {
  const count = run.commits.length;
  return count === 1 ? "1 commit" : `${count} commits`;
}
