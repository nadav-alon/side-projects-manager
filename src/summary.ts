import type { StandDown } from "./budget-gate.ts";
import { workLocation } from "./handback-comment.ts";
import {
  handedBackForModelLabels,
  type Finished,
  type IterationOutcome,
  type NotClosed,
  type Reviewed,
  type RunFailure,
} from "./iteration-outcome.ts";
import type {
  InvocationStandDown,
  ProjectOutcome,
  ProjectVerdict,
} from "./morning-run.ts";
import type {
  RepoSlug,
  ReviewTicket,
  SandboxRunResult,
  Ticket,
  TokenCount,
} from "./ports/index.ts";
import {
  READY_FOR_AGENT_LABEL,
  READY_FOR_HUMAN_LABEL,
  localDay,
} from "./ports/index.ts";

/** How a verdict reads to the developer. A selected project was not skipped. */
function skipReason(verdict: ProjectVerdict): string | undefined {
  switch (verdict) {
    case "paused":
      return "paused";
    case "no-eligible-tickets":
      return "no ready-for-agent tickets";
    case "deferred":
      return "outranked this morning";
    case "selected":
      return undefined;
  }
}

/**
 * Names every ticket a scan passed over for being broken out or blocked,
 * whatever its project's verdict: a project can be selected for one ticket
 * while another in its backlog is passed over, and a backlog that looks full
 * but yields nothing is only explicable if the summary says so.
 */
function passedOverAside(projects: ProjectOutcome[]): string {
  const passedOver = projects.flatMap(({ repo, brokenOut, blocked }) => {
    const reasons = [
      ...(brokenOut === undefined
        ? []
        : [`${numbers(brokenOut)} broken out into sub-issues`]),
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
    return `The invocation did not finish: ${facts.invocationFailure}.`;
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
 * the provider gave.
 *
 * `when` is whether any run came before the stand-down, which only changes
 * how the gate's refused project is introduced.
 */
function whyStoodDown(
  standDown: InvocationStandDown,
  when: "first" | "next",
): string {
  if (standDown.reason === "provider-limit") {
    const { ticket, limitRefusal } = standDown;
    return `${limitRefusal}. ${ticket.repo} #${ticket.number} is still ${READY_FOR_AGENT_LABEL} and will come round again.`;
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

/** `startedAt`'s local time, as `HH:MM`. */
function localTimeOfMinute(at: Date): string {
  const hours = `${at.getHours()}`.padStart(2, "0");
  const minutes = `${at.getMinutes()}`.padStart(2, "0");
  return `${hours}:${minutes}`;
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
    waitingSection(facts.iterations),
  ]
    .filter((section): section is string => section !== undefined)
    .join("\n\n");
}

/**
 * One bullet per attempt this invocation made, its outcome, its cost, and the
 * model it was started on. A ticket handed back for its model labels was never
 * started, so it names neither.
 */
function attemptsSection(iterations: IterationOutcome[]): string {
  const lines = iterations.map((iteration) => {
    if (handedBackForModelLabels(iteration)) {
      return `- ${describeIteration(iteration)} — nothing run`;
    }
    const spent = costOf(iteration);
    const cost =
      spent === undefined ? " — cost unknown" : ` — ${tokens(spent)} tokens`;
    return `- ${describeIteration(iteration)}${cost} on ${iteration.model ?? "the image's model"}`;
  });
  return ["## Attempts", ...lines].join("\n");
}

/** A ticket whose hand-back itself failed: still eligible, still waiting on a human to relabel it by hand. */
function stillEligibleLine(iteration: {
  repo: RepoSlug;
  ticket: Ticket;
}): string {
  return `- ${iteration.repo} #${iteration.ticket.number}: still ${READY_FOR_AGENT_LABEL} — the hand-back itself failed, relabel it yourself`;
}

/**
 * What now needs the developer: a draft pull request to review, a ticket
 * relabelled for human attention, a setup that broke under a ticket it left
 * eligible, or — the one case a failed run can leave
 * behind that is the developer's alone, per `RunFailure.handedBack`'s own
 * note — a ticket the hand-back itself could not reach, still eligible and
 * due to come round again until somebody relabels it by hand. A review the
 * loop could not close is there for the same reason.
 */
function waitingSection(iterations: IterationOutcome[]): string | undefined {
  const lines = iterations.flatMap((iteration): string[] => {
    switch (iteration.kind) {
      case "reviewed":
        return iteration.notClosed === undefined
          ? []
          : [notClosedLine(iteration, iteration.notClosed)];
      // A limit refusal's ticket waits on the provider, not the developer.
      case "limit-refused":
        return [];
      case "failed":
        return [
          waitingOnFailure(iteration.repo, iteration.ticket, iteration.failure),
        ];
      case "finished": {
        // A finished run's own hand-back, covering the two cases a queued
        // review does not: a run that committed nothing, which has nothing to
        // name but the relabel itself, and a run whose hand-back — of either
        // kind — was refused by the tracker.
        const { handover, handbackFailure } = iteration;
        return [
          ...(handover === undefined
            ? []
            : [
                `- ${iteration.repo}: ${handover.pullRequest} — review queued as #${handover.reviewTicket.number}`,
              ]),
          ...(handbackFailure !== undefined
            ? [stillEligibleLine(iteration)]
            : handover === undefined
              ? [
                  `- ${iteration.repo} #${iteration.ticket.number}: relabelled ${READY_FOR_HUMAN_LABEL} — the run committed nothing`,
                ]
              : []),
        ];
      }
    }
  });

  return lines.length === 0
    ? undefined
    : ["## Waiting on you", ...lines].join("\n");
}

/** What a failed run leaves waiting on the developer. */
function waitingOnFailure(
  repo: RepoSlug,
  ticket: Ticket,
  failure: RunFailure,
): string {
  switch (failure.kind) {
    case "infrastructure":
      return `- ${repo} #${ticket.number}: still ${READY_FOR_AGENT_LABEL} — the sandbox or checkout failed, so fix the setup: ${failure.reason}`;
    case "gave-up":
      return failure.handedBack
        ? `- ${repo} #${ticket.number}: relabelled ${READY_FOR_HUMAN_LABEL}`
        : stillEligibleLine({ repo, ticket });
    case "handover-failed":
      return failure.handedBack
        ? `- ${repo} #${ticket.number}: relabelled ${READY_FOR_HUMAN_LABEL} — its work is on ${workLocation(failure)}, but ${failure.reason}`
        : stillEligibleLine({ repo, ticket });
    case "model-refused":
      return failure.handedBack
        ? `- ${repo} #${ticket.number}: relabelled ${READY_FOR_HUMAN_LABEL} — the model ${failure.refusal.model} was refused, so fix the ${failure.source}`
        : stillEligibleLine({ repo, ticket });
    case "conflicting-model-labels":
    case "unusable-model-label":
      return failure.handedBack
        ? `- ${repo} #${ticket.number}: relabelled ${READY_FOR_HUMAN_LABEL} — fix its model labels (${failure.labels.join(", ")})`
        : stillEligibleLine({ repo, ticket });
  }
}

/**
 * What one iteration's run or review cost. Absent only for a run that never
 * started — an infrastructure failure before the sandbox spent anything.
 */
function costOf(iteration: IterationOutcome): TokenCount | undefined {
  switch (iteration.kind) {
    case "reviewed":
      return iteration.review.tokensUsed;
    case "limit-refused":
      return iteration.tokensUsed;
    case "failed":
      return iteration.run?.tokensUsed ?? iteration.tokensUsed;
    case "finished":
      return iteration.run.tokensUsed;
  }
}

/** One line for one iteration: what it landed, why it did not finish, or what it found. */
function describeIteration(iteration: IterationOutcome): string {
  switch (iteration.kind) {
    case "limit-refused": {
      const kept =
        iteration.discard.kind === "kept"
          ? ` Its branch ${iteration.run?.branch ?? ""} could not be discarded: ${iteration.discard.reason}.`
          : "";
      return `The provider limit refused the run on ${iteration.repo} #${iteration.ticket.number}.${kept}`;
    }
    case "failed":
      return `Attempted ${iteration.repo}: ${stoppedBecause(iteration.failure, iteration.ticket)}`;
    case "reviewed":
      return reviewSummary(iteration);
    case "finished":
      return `Worked ${iteration.repo}: ${landed(iteration)}.${queued(iteration)}${handbackNote(iteration)}`;
  }
}

/**
 * Says when a finished run's own hand-back — the relabel that takes its
 * ticket out of the queue — was refused. Empty when it succeeded, since
 * `landed` and `queued` already say what became of the run itself, and a
 * ticket successfully handed back needs nothing more said about it here.
 */
function handbackNote(finished: Finished): string {
  if (finished.handbackFailure === undefined) {
    return "";
  }
  return ` The ticket could not be handed back: ${finished.handbackFailure} — still ${READY_FOR_AGENT_LABEL} and will come round again; relabel it yourself.`;
}

/**
 * How a review ticket's own run reads to the developer: where its findings
 * landed, or why the loop could not finish the ticket off.
 */
function reviewSummary(
  iteration: { repo: RepoSlug; ticket: ReviewTicket } & Reviewed,
): string {
  const { repo, ticket, notClosed } = iteration;
  switch (notClosed?.kind) {
    case undefined:
      return `Reviewed ${repo} #${ticket.number}: posted findings on ${ticket.pullRequest}.`;
    case "check-failed":
      return `Reviewed ${repo} #${ticket.number}, but ${ticket.pullRequest} could not be checked for its findings: ${notClosed.error}. Still ${READY_FOR_AGENT_LABEL}: check ${ticket.pullRequest} and close it yourself.`;
    case "close-failed":
      return `Reviewed ${repo} #${ticket.number}: posted findings on ${ticket.pullRequest}, but the ticket could not be closed: ${notClosed.error}. Still ${READY_FOR_AGENT_LABEL}: close it yourself.`;
  }
}

/** The Waiting-on-you line for a review that ran but left its ticket open. */
function notClosedLine(
  { repo, ticket }: { repo: RepoSlug; ticket: ReviewTicket },
  notClosed: NotClosed,
): string {
  const still = `- ${repo} #${ticket.number}: still ${READY_FOR_AGENT_LABEL}`;
  switch (notClosed.kind) {
    case "check-failed":
      return `${still} — ${ticket.pullRequest} could not be checked for its findings: ${notClosed.error}; check it and close the ticket yourself`;
    case "close-failed":
      return `${still} — its findings are on ${ticket.pullRequest}, but it could not be closed: ${notClosed.error}; close it yourself`;
  }
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
 * Why the morning stopped, in the half-sentence the summary carries.
 *
 * Names the ticket, because the developer's next move is to open it: the whole
 * of what happened is in the comment waiting there.
 */
function stoppedBecause(failure: RunFailure, ticket: Ticket): string {
  const which = `#${ticket.number}`;
  if (failure.kind === "infrastructure") {
    return `the run would not start on ${which}: ${failure.reason}. ${which} is still ${READY_FOR_AGENT_LABEL}; fix the setup and it will come round again.`;
  }
  // A ticket that could not be handed back is the one thing here the developer
  // has to act on themselves: it is still eligible, so it will come round and
  // cost another morning until somebody relabels it.
  const now = failure.handedBack
    ? "Handed back for a human."
    : `${which} is still ${READY_FOR_AGENT_LABEL} and will come round again — relabel it yourself.`;
  switch (failure.kind) {
    case "gave-up":
      return `the agent gave up on ${which}: ${failure.reason}. ${now}`;
    case "handover-failed":
      return `${which} finished on ${workLocation(failure)}, but its work could not be handed over: ${failure.reason}. ${now}`;
    case "model-refused":
      return `${which} was not worked, because ${failure.reason}. ${now}`;
    case "conflicting-model-labels":
    case "unusable-model-label":
      return `${which} was not run, because ${failure.reason}. ${now}`;
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
 * what it was measured, and which of the two windows said no.
 */
function standDownReason(standDown: StandDown): string {
  const spent = `${tokens(standDown.tokensUsed)} of ${tokens(standDown.spendable)} tokens`;
  return standDown.reason === "weekly-reserve"
    ? `spending more of the week would eat into the reserve (${spent} spendable this week)`
    : `the 5-hour window is spent (${spent})`;
}

function tokens(count: TokenCount): string {
  return count.toLocaleString("en-US");
}

/** How many commits the run left, said the way a person would say it. */
function commitCount(run: SandboxRunResult): string {
  const count = run.commits.length;
  return count === 1 ? "1 commit" : `${count} commits`;
}
