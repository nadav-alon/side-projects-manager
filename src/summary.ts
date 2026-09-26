import type { StandDown } from "./budget-gate.ts";
import { pullRequestResolutionPhrase } from "./close-comment.ts";
import type {
  ConflictSweepChange,
  ConflictSweepOutcome,
  ConflictSweepRefusal,
} from "./conflict-sweep.ts";
import { isBlockingDiscoveryKind } from "./discovery-routing.ts";
import type { DiscoveryReport, DiscoveryRouting } from "./discovery-routing.ts";
import { errorMessage } from "./error-message.ts";
import type {
  SpecReviewSweepLink,
  SpecReviewSweepOutcome,
  SpecReviewSweepRefusal,
} from "./spec-review-sweep.ts";
import type { Discard, HandBackRecord } from "./hand-back.ts";
import { workLocation } from "./hand-back.ts";
import {
  countsAsWork,
  failedOnInfrastructure,
  handedBackFailure,
  ranNothing,
  type AppliedReview,
  type Attempt,
  type BudgetExhausted,
  type CutOff,
  type Failed,
  type Finished,
  type Handover,
  type IterationOutcome,
  type MergeGate,
  type NotClosed,
  type NotCommented,
  type NotLabelled,
  type NotReadied,
  type PullRequestResolved,
  type Rebased,
  type Reviewed,
  type SpecReviewed,
} from "./iteration-outcome.ts";
import { modelProblem } from "./model-resolution.ts";
import { sizeProblem } from "./size-resolution.ts";
import type { ProjectOutcome, ProjectVerdict } from "./selection.ts";
import type { FreedWorkedTicket } from "./invocation-state.ts";
import type {
  ApplyReviewTicket,
  IssueUrl,
  InvocationOutcome as JournaledInvocationOutcome,
  PullRequestLabel,
  PullRequestTicket,
  PullRequestUrl,
  RebaseTicket,
  RepoSlug,
  ReviewTicket,
  RunFinished,
  Salvaged,
  Size,
  SpecReviewTicket,
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
  READY_FOR_HUMAN_PULL_REQUEST_LABEL,
  REBASE_COMMENT,
  REVIEWED_LABEL,
  declaredSize,
  isRebaseTicket,
  isReviewTicket,
  localDay,
  localTimeOfMinute,
} from "./ports/index.ts";

/**
 * The one write on the tracker that `ports/issue-tracker.ts` deliberately
 * leaves undeclared: publishing the invocation's summary issue. Declared
 * here, beside the summary it publishes, per that port's own note.
 *
 * Every other tracker method writes into a project's repo, named by a ticket
 * it is handed. This one names nothing, because it always lands in the
 * tracker's own repo rather than a project's — the manager reports on itself.
 */
export interface SummaryTracker {
  /** Publishes the summary issue, and answers with where it landed. */
  publishSummary(title: string, body: string): Promise<IssueUrl>;
}

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
        : [`${numbers(supertasks)} declared a supertask`]),
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
 * Names every ticket a scan found with an open sub-issue that is not a pull
 * request ticket, yet no supertask label — reported, not skipped, so a
 * container an agent could otherwise pick up and implement as ordinary work
 * still gets a developer's attention.
 */
function missingSupertaskLabelAside(projects: ProjectOutcome[]): string {
  const flagged = projects.flatMap(({ repo, missingSupertaskLabel }) =>
    missingSupertaskLabel === undefined
      ? []
      : [`${repo} (${numbers(missingSupertaskLabel)})`],
  );
  return flagged.length > 0
    ? ` Check for a missed supertask label: ${flagged.join(", ")}.`
    : "";
}

/**
 * One project's conflict sweep activity, built across every sweep the
 * invocation ran before a selection. A label or unlabel met by several
 * sweeps for the same pull request appears once under its action in
 * `changes`, and the same refusal appears once in `refusals` — a repeat
 * sweep finding the pull request already in the shape it would put it is
 * the same fact stated twice, not two events. A `/rebase` post is different:
 * a pull request whose rebase ticket has closed can be posted on again in
 * the same invocation, and each post opens its own ticket, so `commented`
 * keeps every one, unfiltered — a pull request posted on twice appears in it
 * twice. Built by {@link conflictSweepProjects}, and read by
 * both the summary line's short aside and the body's own section, so the two
 * never drift apart on what counts as "changed" or "refused".
 */
interface ConflictSweepProject {
  repo: RepoSlug;
  changes: Map<GroupedChangeAction, PullRequestUrl[]>;
  commented: PullRequestUrl[];
  refusals: ConflictSweepRefusal[];
}

/** A {@link ConflictSweepChange} action grouped and deduplicated by url, unlike `commented`, which is kept post by post. */
type GroupedChangeAction = Exclude<ConflictSweepChange["action"], "commented">;

/**
 * The past participle {@link ConflictSweepChange} names its action by, in the
 * phrase {@link conflictSweepSection} renders for it, for every action
 * `changes` groups by url — `commented` renders one bullet per post instead,
 * so it is named apart from this. Keyed the same way `CHANGED` in
 * `conflict-sweep.ts` keys its own vocabulary, for these two: one place per
 * grouped action, so adding a third means adding one line here rather than a
 * new branch in every renderer.
 */
const CHANGE_PHRASE: Record<GroupedChangeAction, (urls: string) => string> = {
  labelled: (urls) => `labelled ${NEEDS_REBASE_LABEL} on ${urls}`,
  unlabelled: (urls) => `removed ${NEEDS_REBASE_LABEL} from ${urls}`,
};

/** The order {@link conflictSweepSection} renders a project's grouped change bullets in, ahead of its `commented` bullets. */
const CHANGE_ORDER: GroupedChangeAction[] = ["labelled", "unlabelled"];

/**
 * The key a labelled or unlabelled change is deduplicated by: the pull
 * request and action it names. Takes the grouped action apart from the full
 * change so `commented`, which is never deduplicated, cannot be passed here.
 */
function conflictSweepChangeKey(
  repo: RepoSlug,
  action: GroupedChangeAction,
  pullRequest: PullRequestUrl,
): string {
  return `${repo}|${action}|${pullRequest}`;
}

/** The key a refusal is deduplicated by: what it names, since a `"list"` refusal names no pull request. */
function conflictSweepRefusalKey(
  repo: RepoSlug,
  refusal: ConflictSweepRefusal,
): string {
  return refusal.action === "list"
    ? `${repo}|list`
    : `${repo}|${refusal.action}|${refusal.pullRequest}`;
}

/**
 * Every conflict sweep outcome of the invocation, grouped by project and
 * deduplicated the way `CONTEXT.md`'s "Conflict sweep" and ADR 0007 describe:
 * one invocation sweeps before every selection, so the same pull request
 * labelled or unlabelled, or the same refusal, can be met by several sweeps
 * and is reported once. A `/rebase` post is kept apart from that rule: a
 * pull request can be posted on more than once in the same invocation, each
 * post opening its own ticket, so every `commented` change is kept, not
 * deduplicated. A project with nothing changed and nothing refused is left
 * out entirely.
 */
function conflictSweepProjects(
  conflictSweeps: ConflictSweepOutcome[],
): ConflictSweepProject[] {
  const projects = new Map<RepoSlug, ConflictSweepProject>();
  const seenChanges = new Set<string>();
  const seenRefusals = new Set<string>();

  for (const outcome of conflictSweeps) {
    let project = projects.get(outcome.repo);
    if (project === undefined) {
      project = { repo: outcome.repo, changes: new Map(), commented: [], refusals: [] };
      projects.set(outcome.repo, project);
    }

    for (const change of outcome.changes) {
      if (change.action === "commented") {
        project.commented.push(change.pullRequest);
        continue;
      }
      const key = conflictSweepChangeKey(outcome.repo, change.action, change.pullRequest);
      if (seenChanges.has(key)) {
        continue;
      }
      seenChanges.add(key);
      const urls = project.changes.get(change.action) ?? [];
      urls.push(change.pullRequest);
      project.changes.set(change.action, urls);
    }

    for (const refusal of outcome.refusals) {
      const key = conflictSweepRefusalKey(outcome.repo, refusal);
      if (seenRefusals.has(key)) {
        continue;
      }
      seenRefusals.add(key);
      project.refusals.push(refusal);
    }
  }

  return [...projects.values()].filter(
    (project) =>
      project.changes.size > 0 || project.commented.length > 0 || project.refusals.length > 0,
  );
}

/**
 * The summary line's own short aside on conflict sweeps: present only when a
 * sweep posted {@link REBASE_COMMENT} or was refused something — the cases
 * that need the developer's eye, per ADR 0007's "Best effort" bullet. A
 * label added or removed stays in the body alone.
 */
function conflictSweepAside(conflictSweeps: ConflictSweepOutcome[]): string {
  const flagged = conflictSweepProjects(conflictSweeps).flatMap((project) => {
    const commented = project.commented.length;
    const bits = [
      ...(commented > 0
        ? [`posted ${REBASE_COMMENT} ${commented === 1 ? "once" : `${commented} times`}`]
        : []),
      ...(project.refusals.length > 0
        ? [`refused ${project.refusals.length === 1 ? "once" : `${project.refusals.length} times`}`]
        : []),
    ];
    return bits.length > 0 ? [`${project.repo} (${bits.join("; ")})`] : [];
  });
  return flagged.length > 0 ? ` Conflict sweep: ${flagged.join(", ")}.` : "";
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

export type InvocationOutcome =
  /** No registered project had an eligible ticket. A quiet morning. */
  | "dry-queue"
  /** There was work, and the budget gate refused to start it. */
  | "stood-down"
  /** An iteration selected a project with work. */
  | "work-selected"
  /**
   * The loop's own plumbing broke before it could finish — a registry that
   * would not parse, or a port that could not be reached before a single
   * iteration ran. Distinct from a run that gave up or an infrastructure
   * failure inside one iteration, both of which are reported as normal
   * iterations; this is the invocation itself never getting that far.
   */
  | "invocation-failed";

/**
 * Kept assignable to the store port's own copy of this union: a variant
 * added here without being added to `ports/journal.ts`'s `InvocationOutcome`
 * fails the default below, rather than surfacing later as a runtime parse
 * error when the journal tries to read back an outcome it does not
 * recognise. Exported only so `noUnusedLocals` doesn't flag it; nothing
 * outside this module has a reason to reference it.
 */
export type OutcomeStaysInSyncWithJournal<
  T extends JournaledInvocationOutcome = InvocationOutcome,
> = T;

/**
 * A summary the invocation composed but could not publish: why, and the body
 * it had already put together. Carried as its own field rather than only
 * folded into `message`'s prose, so the entry point can write the body down
 * and the journal can record why — the one write meant to report the morning
 * is not allowed to be the one that loses its account of itself.
 */
export interface SummaryFailure {
  reason: string;
  body: string;
}

/** The gate's refusal, and the project it turned away. */
export interface GateStandDown extends StandDown {
  /** The project that was ready to work when the gate refused. */
  refused: RepoSlug;
}

/**
 * A stand-down the gate never saw coming: a limit refusal. The allowance the
 * gate measures against is only the developer's declaration of the provider
 * limit, so the gate can say go while the provider says no — and every run
 * after the first refusal would be refused the same way.
 */
export interface ProviderLimitStandDown {
  reason: "provider-limit";
  /** What the provider said, reset time included, word for word. */
  limitRefusal: string;
  /** The ticket whose run it refused. */
  ticket: Ticket;
  /**
   * Whether `ticket` was handed back for a blocking discovery its run filed
   * before the provider refused it, rather than left eligible exactly as it
   * was — per CONTEXT.md's "Discovery", true only when the hand-back landed.
   */
  handedBack: boolean;
}

/**
 * A stand-down the gate never saw coming either: a provider failure — down,
 * overloaded or unreachable. As `ProviderLimitStandDown`, every run after the
 * first would be stopped the same way.
 */
export interface ProviderFailureStandDown {
  reason: "provider-failure";
  /** What the CLI said, word for word. */
  providerFailure: string;
  /** The ticket whose run it stopped. */
  ticket: Ticket;
  /** As `ProviderLimitStandDown.handedBack`. */
  handedBack: boolean;
}

/**
 * A stand-down the developer asked for, by stopping the invocation by hand.
 * Nothing about the budget or any ticket: every ticket not yet started is left
 * exactly as it was.
 */
export interface DeveloperStandDown {
  reason: "stopped";
}

/** Why an invocation stood down: the gate refused, the provider did, or the developer stopped it. */
export type InvocationStandDown =
  | GateStandDown
  | ProviderLimitStandDown
  | ProviderFailureStandDown
  | DeveloperStandDown;

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
  conflictSweeps: ConflictSweepOutcome[];
  specReviewSweeps: SpecReviewSweepOutcome[];
  /** Every ticket freed because a dead in-flight invocation had recorded it. */
  freedFromDeadInvocation: FreedWorkedTicket[];
}

/**
 * The summary in one line: the invocation's `message`, and the body's
 * opening. An invocation failure returns before the skipped, passed-over,
 * missing-label and conflict-sweep asides are built, same as it always has:
 * none of them appear on this line when the invocation itself didn't finish.
 */
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
  const missingLabel = missingSupertaskLabelAside(projects);
  const sweeps = conflictSweepAside(facts.conflictSweeps);
  const specReviews = specReviewSweepAside(facts.specReviewSweeps);
  const aside = `${skipped.length > 0 ? ` Skipped ${skipped.join(", ")}.` : ""}${passedOver}${missingLabel}${sweeps}${specReviews}`;

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
  return `Nothing to do: skipped ${skipped.join(", ")}.${passedOver}${missingLabel}${sweeps}${specReviews}`;
}

/**
 * Why the invocation stood down, and what that left waiting. The gate names
 * the project it turned away and when the window resets. A limit refusal
 * names the ticket it refused and quotes what the provider said: still
 * eligible and due to come round again, unless its run also filed a blocking
 * discovery, in which case it says the ticket was handed back instead — see
 * CONTEXT.md's "Discovery". A provider failure says the same, as a limit
 * refusal. A developer's stop names nothing: they already know why.
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
    const { ticket, handedBack } = standDown;
    const said =
      standDown.reason === "provider-limit"
        ? withoutTrailingStop(standDown.limitRefusal)
        : `a provider failure stopped it: ${withoutTrailingStop(standDown.providerFailure)}`;
    const ticketNote = handedBack
      ? `${ticket.repo} #${ticket.number} was handed back for the blocking discovery it filed.`
      : `${ticket.repo} #${ticket.number} is still ${READY_FOR_AGENT_LABEL} and will come round again.`;
    return `${said}. ${ticketNote}`;
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
 * rather than recomputed from `facts`: `composeInvocationReport` composes it
 * once and threads it through to both `message` and this body, and it reads
 * the same either way.
 */
export function summaryBody(facts: SummaryFacts, line: string): string {
  return [
    line,
    facts.iterations.length === 0
      ? undefined
      : attemptsSection(facts.iterations),
    waitingSection(facts.iterations, facts.projects),
    discoveriesSection(facts.iterations),
    conflictSweepSection(facts.conflictSweeps),
    specReviewSweepSection(facts.specReviewSweeps),
    freedFromDeadInvocationSection(facts.freedFromDeadInvocation),
  ]
    .filter((section): section is string => section !== undefined)
    .join("\n\n");
}

/** What one invocation did. The summary issue is written from this. */
export interface InvocationReport {
  /** When the invocation started. */
  startedAt: Date;
  outcome: InvocationOutcome;
  /**
   * Every registered project, in registry order, with why it was skipped —
   * or, once it has been, that it was selected, which then sticks for the
   * rest of the invocation even on a later iteration that finds nothing left
   * of its backlog to select. What each one was actually worked on is in
   * `iterations`; this says only whether its turn came at all.
   */
  projects: ProjectOutcome[];
  /**
   * Every iteration the invocation made, in the order they started — not the
   * order they finished, since several can be in progress at once. Empty on a morning
   * that ran nothing — a dry queue, or a gate that refused before the first
   * run.
   */
  iterations: IterationOutcome[];
  /**
   * Why the invocation stood down, absent when it never did: the gate
   * refusing, before the first run of the morning or between two later ones,
   * the provider limit refusing a run that had already started, or the
   * developer stopping it by hand. Whichever, it is why the invocation stopped rather than having simply run
   * out of work.
   */
  standDown?: InvocationStandDown;
  /**
   * Where a published summary landed. Absent when none published this
   * invocation, or the publish failed.
   */
  summaryLocation?: IssueUrl;
  /**
   * The composed summary, kept because it could not be published. Absent
   * when one published, or none was composed this invocation.
   */
  summaryFailure?: SummaryFailure;
  /**
   * See CONTEXT.md's "Needs attention". The entry point
   * (`bin/morning-run.ts`) reads this field rather than working the same
   * rule out for itself.
   */
  needsAttention: boolean;
  /** One line, suitable for printing to a terminal or into the summary issue. */
  message: string;
}

/**
 * What this invocation came to: whether it worked something, stood down —
 * before or after working something — ran into nothing to do, or never
 * finished at all.
 *
 * A ticket handed back ahead of the gate — for its model or size labels —
 * was never run, and neither was a run the provider limit refused, so
 * neither counts as work when the morning then stood down: a stand-down that
 * ran nothing reads as one, whatever was handed back or refused before it.
 * Without a stand-down, either kind of non-work is still work an iteration
 * selected. A limit refusal that also filed a blocking discovery is a
 * `discovery-blocked` iteration instead, and does count: the discovery needs
 * the developer.
 */
function outcomeOf(facts: SummaryFacts): InvocationOutcome {
  if (facts.invocationFailure !== undefined) {
    return "invocation-failed";
  }
  const worked = facts.iterations.some(countsAsWork);
  if (worked) {
    return "work-selected";
  }
  if (facts.standDown !== undefined) {
    return "stood-down";
  }
  return facts.iterations.length > 0 ? "work-selected" : "dry-queue";
}

/** {@link InvocationReport.needsAttention}, per CONTEXT.md's "Needs attention". */
function needsAttention(
  outcome: InvocationOutcome,
  iterations: IterationOutcome[],
  summaryFailure: SummaryFailure | undefined,
): boolean {
  return (
    outcome === "invocation-failed" ||
    iterations.some(failedOnInfrastructure) ||
    summaryFailure !== undefined
  );
}

/**
 * What {@link composeInvocationReport} needs beyond the facts themselves:
 * when the invocation started, and whether a summary has already been
 * announced today — the one thing about publishing that is the caller's to
 * know, since it turns on the state document rather than on anything the
 * facts of this invocation alone say.
 */
export interface InvocationReportInputs {
  startedAt: Date;
  facts: SummaryFacts;
  alreadyAnnouncedToday: boolean;
}

/**
 * Whether a limit refusal left something for the summary to name: a branch
 * left in the project checkout — kept because git refused to delete it, or
 * salvaged on purpose per CONTEXT.md's "Salvage" — or an advisory discovery
 * filed, the only kind a limit refusal can file since a blocking one hands
 * the ticket back instead and makes this a `DiscoveryBlocked` iteration.
 * Returns false for a `none` or `discarded` discard with nothing filed,
 * however many tokens the refusal spent.
 */
function limitRefusalLeftSomethingToName(iteration: IterationOutcome): boolean {
  if (iteration.kind !== "limit-refused") {
    return false;
  }
  return (
    iteration.discard.kind === "kept" ||
    iteration.discard.kind === "salvaged" ||
    (iteration.discoveryReport?.routing.filed.length ?? 0) > 0
  );
}

/**
 * What an invocation came to, from its own facts alone: the outcome, the
 * one-line message, whether the developer's setup needs attention, and —
 * published here, the summary module's own last step — where the summary
 * issue landed, or the summary a failed publish left composed but homeless.
 *
 * Composes the line once and reuses it for both `message` and, when
 * publishing, the issue body.
 *
 * An invocation that worked something, freed a ticket a dead invocation had
 * recorded, or had a limit refusal that left a branch behind or filed a
 * discovery, always publishes — a freed ticket nobody else will mention must
 * be named somewhere, never only erased from the state document; a branch
 * left in the checkout, or a discovery filed, must reach the developer today
 * rather than wait a day. A quiet or broken one publishes only when today has
 * not already been announced, per CONTEXT.md's "Summary" — a loop firing
 * every hour still reports one quiet or broken morning rather than up to
 * twenty-four.
 */
export async function composeInvocationReport(
  tracker: SummaryTracker,
  { startedAt, facts, alreadyAnnouncedToday }: InvocationReportInputs,
): Promise<InvocationReport> {
  const outcome = outcomeOf(facts);
  const line = summaryLine(facts);

  let summaryLocation: IssueUrl | undefined;
  let summaryFailure: SummaryFailure | undefined;
  if (
    outcome === "work-selected" ||
    facts.freedFromDeadInvocation.length > 0 ||
    facts.iterations.some(limitRefusalLeftSomethingToName) ||
    !alreadyAnnouncedToday
  ) {
    const body = summaryBody(facts, line);
    // Never thrown: a summary issue that could not be written must not cost
    // the developer the account of everything else the invocation did — said
    // in `message`, and kept whole in `summaryFailure`, the same way a
    // tracker that refuses `handBack` is said rather than thrown.
    try {
      summaryLocation = await tracker.publishSummary(
        summaryTitle(startedAt),
        body,
      );
    } catch (error: unknown) {
      summaryFailure = { reason: errorMessage(error), body };
    }
  }

  return {
    startedAt,
    outcome,
    projects: facts.projects,
    iterations: facts.iterations,
    ...(facts.standDown !== undefined && { standDown: facts.standDown }),
    ...(summaryLocation !== undefined && { summaryLocation }),
    ...(summaryFailure !== undefined && { summaryFailure }),
    needsAttention: needsAttention(outcome, facts.iterations, summaryFailure),
    message:
      summaryFailure === undefined
        ? line
        : `${line} The summary issue could not be published: ${summaryFailure.reason}.`,
  };
}

/**
 * `iteration`'s own `DiscoveryReport`, for every kind that can carry one.
 * `undefined` for a kind that never routes discoveries at all, or one whose
 * run filed and dropped nothing.
 */
function discoveryReportOf(iteration: IterationOutcome): DiscoveryReport | undefined {
  switch (iteration.kind) {
    case "discovery-blocked":
    case "finished":
    case "failed":
    case "reviewed":
    case "applied-review":
    case "rebased":
    case "spec-reviewed":
    case "limit-refused":
    case "provider-failed":
      return iteration.discoveryReport;
    case "budget-exhausted":
    case "pull-request-resolved":
      return undefined;
  }
}

/**
 * Every discovery a run filed, dropped or was refused, per CONTEXT.md's
 * "Discovery" and "Dropped discovery" — so nothing a run filed under
 * `/discoveries` disappears silently, whether it landed, was capped, was not
 * valid JSON or named an unknown kind, or the tracker refused to write it.
 * `undefined` when no iteration this invocation made carries anything to say,
 * so the section is absent entirely on a morning with no discoveries.
 */
function discoveriesSection(iterations: IterationOutcome[]): string | undefined {
  const lines = iterations.flatMap((iteration) => {
    const report = discoveryReportOf(iteration);
    return report === undefined ? [] : discoveryLines(iteration, report);
  });
  return lines.length === 0 ? undefined : ["## Discoveries", ...lines].join("\n");
}

/**
 * The discovered ticket a filed discovery named, as the developer reads it:
 * its number, plus `ready-for-agent` when it was opened from a Ready
 * discovery. Shared by {@link discoveryLines} and
 * {@link blockingDiscoveryPhrases} so the two lines a ready ticket appears on
 * cannot drift apart.
 */
function discoveredTicketRef(ticket: Ticket): string {
  return `#${ticket.number}${ticket.readyDiscovery === true ? `, ${READY_FOR_AGENT_LABEL}` : ""}`;
}

/**
 * One bullet per advisory discovery `routing` filed — naming the ticket a
 * comment landed on, or the discovered ticket a suggestion opened — plus one
 * for a positive count of suggestions the cap dropped, one for a positive
 * count of files `/discoveries` dropped for not being valid JSON or naming an
 * unknown kind, and one per refused write, blocking or advisory alike. A
 * blocking discovery is always filed by a `discovery-blocked` iteration —
 * routing hands any other kind's run back as one instead of leaving it its
 * own kind, per CONTEXT.md's "Discovery" — so it has its own kind and
 * outcome said instead by that iteration's own line and Waiting-on-you entry,
 * and is left out here. Every other iteration reaching this function carries
 * advisory discoveries only, listed here the same way regardless of kind.
 * Alongside a refused write, either way, only what happened to the write
 * itself is said. A discovered ticket opened from a **Ready discovery**, and
 * so born `ready-for-agent`, says so, so the developer reading this line can
 * tell it skipped their triage.
 */
function discoveryLines(
  iteration: { repo: RepoSlug; ticket: Ticket },
  { routing, crossTarget }: DiscoveryReport,
): string[] {
  const who = `${iteration.repo} #${iteration.ticket.number}`;
  const landedOn =
    crossTarget === undefined ? `#${iteration.ticket.number}` : `#${crossTarget.number}`;
  const filed = routing.filed.flatMap((filed) => {
    if (isBlockingDiscoveryKind(filed.discovery.kind)) {
      return [];
    }
    const where =
      filed.action === "discovered-ticket"
        ? `opened ${discoveredTicketRef(filed.ticket)}`
        : `commented on ${landedOn}`;
    return [`- ${who}: ${where} — ${filed.discovery.kind}, "${filed.discovery.title}"`];
  });
  const droppedSuggestions =
    routing.suggestionsDropped === 0
      ? []
      : [
          `- ${who}: dropped ${routing.suggestionsDropped === 1 ? "1 suggestion" : `${routing.suggestionsDropped} suggestions`} past the one already filed`,
        ];
  const droppedFiles =
    routing.discoveriesDropped === 0
      ? []
      : [
          `- ${who}: dropped ${routing.discoveriesDropped === 1 ? "1 file" : `${routing.discoveriesDropped} files`} under /discoveries — not valid JSON, or naming an unknown kind`,
        ];
  const refused = routing.refused.map(
    (refused) =>
      `- ${who}: could not file a ${refused.discovery.kind} ("${refused.discovery.title}"): ${withoutTrailingStop(refused.reason)}`,
  );
  return [...filed, ...droppedSuggestions, ...droppedFiles, ...refused];
}

/**
 * One bullet per ticket freed because a dead in-flight invocation had
 * recorded it as worked today — CONTEXT.md's "Freed". Names the invocation
 * each freed ticket came from, by its opened-at instant and pid. `undefined`
 * when nothing was freed this way.
 */
function freedFromDeadInvocationSection(
  freed: FreedWorkedTicket[],
): string | undefined {
  if (freed.length === 0) {
    return undefined;
  }
  const lines = freed.map(
    ({ ticket, invocation }) =>
      `- ${ticket.repo} #${ticket.number}: freed — recorded by the invocation opened ${localDay(invocation.openedAt)} ${localTimeOfMinute(invocation.openedAt)} by process ${invocation.process}, never closed`,
  );
  return ["## Freed from a dead invocation", ...lines].join("\n");
}

/**
 * One bullet per project's conflict sweep activity: a pull request labelled
 * {@link NEEDS_REBASE_LABEL}, one that had it removed — each once, however
 * many sweeps met it — one per {@link REBASE_COMMENT} post, one bullet per
 * post rather than grouped, since two posts on the same pull request are two
 * distinct events in one invocation, and a refusal naming what it was trying
 * and the error, per `conflictSweepProjects`. `undefined` when no sweep this
 * invocation changed or was refused anything, so the section is absent
 * entirely — pinned byte-for-byte by the test "renders nothing extra, byte
 * for byte, when no sweep changed or refused anything" in `summary.test.ts`.
 */
function conflictSweepSection(
  conflictSweeps: ConflictSweepOutcome[],
): string | undefined {
  const projects = conflictSweepProjects(conflictSweeps);
  if (projects.length === 0) {
    return undefined;
  }
  const lines = projects.flatMap((project) => [
    ...CHANGE_ORDER.flatMap((action) => {
      const urls = project.changes.get(action);
      return urls === undefined
        ? []
        : [`- ${project.repo}: ${CHANGE_PHRASE[action](urls.join(", "))}`];
    }),
    ...project.commented.map(
      (pullRequest) => `- ${project.repo}: posted ${REBASE_COMMENT} on ${pullRequest}`,
    ),
    ...project.refusals.map((refusal) => conflictSweepRefusalLine(project.repo, refusal)),
  ]);
  return ["## Conflict sweeps", ...lines].join("\n");
}

/** One refusal a conflict sweep met, naming what it was trying and the error. */
function conflictSweepRefusalLine(
  repo: RepoSlug,
  refusal: ConflictSweepRefusal,
): string {
  const error = withoutTrailingStop(refusal.error);
  switch (refusal.action) {
    case "list":
      return `- ${repo}: could not list its open pull requests: ${error}`;
    case "read":
      return `- ${repo}: could not check ${refusal.pullRequest}'s mergeability: ${error}`;
    case "label":
      return `- ${repo}: could not label ${refusal.pullRequest} ${NEEDS_REBASE_LABEL}: ${error}`;
    case "unlabel":
      return `- ${repo}: could not remove ${NEEDS_REBASE_LABEL} from ${refusal.pullRequest}: ${error}`;
    case "comment":
      return `- ${repo}: could not post ${REBASE_COMMENT} on ${refusal.pullRequest}: ${error}`;
  }
}

/** The key a spec review sweep refusal is deduplicated by: the project and the supertask it names. */
function specReviewSweepRefusalKey(
  repo: RepoSlug,
  refusal: SpecReviewSweepRefusal,
): string {
  return `${repo}|${refusal.supertask.number}`;
}

/** The key a spec review sweep link is deduplicated by: the project, the supertask and the spec review it was linked to. */
function specReviewSweepLinkKey(repo: RepoSlug, link: SpecReviewSweepLink): string {
  return `${repo}|${link.supertask.number}|${link.specReview.number}`;
}

/**
 * One project's spec review sweep activity, grouped across every sweep the
 * invocation ran. `opened` needs no deduplicating: a supertask a sweep opened
 * a spec review for is never met by a later scan the same invocation ran —
 * its own new sub-issue is what the next scan sees. `linked` and `refusals`
 * are deduplicated all the same, the way a refusal is — nothing in {@link
 * SpecReviewSweepOutcome}'s own type guarantees a link or a refusal is met by
 * at most one scan, so this function does not lean on it, the same way
 * {@link conflictSweepProjects} dedupes its own refusals. A project with
 * nothing opened, nothing linked and nothing refused is left out entirely.
 */
function specReviewSweepProjects(
  specReviewSweeps: SpecReviewSweepOutcome[],
): SpecReviewSweepOutcome[] {
  const projects = new Map<RepoSlug, SpecReviewSweepOutcome>();
  const seenLinks = new Set<string>();
  const seenRefusals = new Set<string>();

  for (const swept of specReviewSweeps) {
    let project = projects.get(swept.repo);
    if (project === undefined) {
      project = { repo: swept.repo, opened: [], linked: [], refusals: [] };
      projects.set(swept.repo, project);
    }
    project.opened.push(...swept.opened);

    for (const link of swept.linked) {
      const key = specReviewSweepLinkKey(swept.repo, link);
      if (seenLinks.has(key)) {
        continue;
      }
      seenLinks.add(key);
      project.linked.push(link);
    }

    for (const refusal of swept.refusals) {
      const key = specReviewSweepRefusalKey(swept.repo, refusal);
      if (seenRefusals.has(key)) {
        continue;
      }
      seenRefusals.add(key);
      project.refusals.push(refusal);
    }
  }
  return [...projects.values()].filter(
    (project) =>
      project.opened.length > 0 || project.linked.length > 0 || project.refusals.length > 0,
  );
}

/**
 * The summary line's own short aside on spec review sweeps: present only when
 * a sweep opened one, linked one or was refused something — the developer's
 * ticket to pick up starts the same as any other, so an opened or linked
 * spec review earns a place on the line itself rather than only in the body.
 */
function specReviewSweepAside(specReviewSweeps: SpecReviewSweepOutcome[]): string {
  const flagged = specReviewSweepProjects(specReviewSweeps).flatMap((project) => {
    const bits = [
      ...(project.opened.length > 0
        ? [`opened ${numbers(project.opened)}`]
        : []),
      ...(project.linked.length > 0
        ? [`linked ${numbers(project.linked.map((link) => link.specReview))}`]
        : []),
      ...(project.refusals.length > 0
        ? [`refused ${project.refusals.length === 1 ? "once" : `${project.refusals.length} times`}`]
        : []),
    ];
    return bits.length > 0 ? [`${project.repo} (${bits.join("; ")})`] : [];
  });
  return flagged.length > 0 ? ` Spec review sweep: ${flagged.join(", ")}.` : "";
}

/**
 * One bullet per project's spec review sweep activity: a spec review it
 * opened, one it found floating and linked instead, worded distinctly from
 * an opened one so a developer who read a prior refusal sees it was
 * resolved, and a refusal naming the supertask and the error — each once,
 * however many sweeps met it, per `specReviewSweepProjects`. `undefined`
 * when no sweep this invocation opened, linked or was refused anything, so
 * the section is absent entirely.
 */
function specReviewSweepSection(
  specReviewSweeps: SpecReviewSweepOutcome[],
): string | undefined {
  const projects = specReviewSweepProjects(specReviewSweeps);
  if (projects.length === 0) {
    return undefined;
  }
  const lines = projects.flatMap((project) => [
    ...project.opened.map(
      (ticket) => `- ${project.repo}: opened #${ticket.number} (${ticket.title})`,
    ),
    ...project.linked.map(
      (link) => `- ${project.repo}: linked #${link.specReview.number} (${link.specReview.title})`,
    ),
    ...project.refusals.map((refusal) => specReviewSweepRefusalLine(project.repo, refusal)),
  ]);
  return ["## Spec review sweep", ...lines].join("\n");
}

/**
 * One spec review sweep refusal, naming the supertask and the error, phrased
 * by which step refused — a refusal from the read that comes before either is
 * attempted must not read as an open or a link that never happened, the way
 * a single fixed phrase for every refusal once did.
 */
function specReviewSweepRefusalLine(
  repo: RepoSlug,
  refusal: SpecReviewSweepRefusal,
): string {
  const error = withoutTrailingStop(refusal.error);
  switch (refusal.action) {
    case "read":
      return `- ${repo}: could not check #${refusal.supertask.number} for a spec review: ${error}`;
    case "open":
      return `- ${repo}: could not open a spec review for #${refusal.supertask.number}: ${error}`;
    case "link":
      return `- ${repo}: could not link an existing spec review to #${refusal.supertask.number}: ${error}`;
  }
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
 *
 * The estimate is itself absent only for a ticket handed back ahead of the
 * gate (`iteration-outcome.ts`'s `Attempt.estimateCharged`), which never
 * reaches here — every iteration this is called for ran, so the gate
 * consulted it and charged one. Said as unknown rather than silently
 * dropped, on the chance that invariant ever stops holding.
 */
function costClause(iteration: IterationOutcome): string {
  const spent = iteration.tokensUsed;
  if (spent === undefined) {
    return " — cost unknown";
  }
  const estimate = iteration.estimateCharged;
  if (estimate === undefined) {
    return ` — ${tokens(spent)} tokens, estimate unknown`;
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

/**
 * The blocking discoveries a discovery-blocked run's own `routing` carries,
 * each as the phrase `describeIteration` and `discoveryBlockedWaitingLine`
 * both read: a correction or a prerequisite, filed — naming the discovered
 * ticket a prerequisite opened, and whether it was opened from a **Ready
 * discovery** — or refused, naming why. Worded the same neutral way
 * `discoveryLines` words a refused write, rather than naming the tracker:
 * `routeRunDiscoveries` refuses every discovery the same way when it cannot
 * even resolve a target for them, which is not the tracker's doing. Read
 * from `routing` rather than recomputing the ticket's own hand-back wording,
 * so the summary and the ticket comment can drift in phrasing without
 * drifting in fact.
 */
function blockingDiscoveryPhrases(routing: DiscoveryRouting): string[] {
  const filed = routing.filed.flatMap((filed) =>
    isBlockingDiscoveryKind(filed.discovery.kind)
      ? [
          filed.action === "discovered-ticket"
            ? `a ${filed.discovery.kind}, opened as ${discoveredTicketRef(filed.ticket)}`
            : `a ${filed.discovery.kind}`,
        ]
      : [],
  );
  const refused = routing.refused.flatMap((refused) =>
    isBlockingDiscoveryKind(refused.discovery.kind)
      ? [`a ${refused.discovery.kind} that could not be filed: ${withoutTrailingStop(refused.reason)}`]
      : [],
  );
  return [...filed, ...refused];
}

/** `blockingDiscoveryPhrases`, joined the one way both of its callers read it. */
function blockingDiscoveryClause(routing: DiscoveryRouting): string {
  return blockingDiscoveryPhrases(routing).join("; ");
}

/**
 * The Waiting-on-you line for a ticket handed back for a blocking discovery
 * that landed: worded apart from a gave-up hand-back's bare relabel and from
 * an infrastructure failure's still-eligible line, since neither the agent
 * nor the setup is what stopped this ticket — the ticket itself is.
 */
function discoveryBlockedWaitingLine(iteration: {
  repo: RepoSlug;
  ticket: Ticket;
  discoveryReport: DiscoveryReport;
}): string {
  const blocking = blockingDiscoveryClause(iteration.discoveryReport.routing);
  return `- ${iteration.repo} #${iteration.ticket.number}: relabelled ${READY_FOR_HUMAN_LABEL} — the ticket is the problem, not the run: it filed ${blocking}`;
}

/** A ticket whose hand-back itself failed: still eligible, still waiting on a human to relabel it by hand. */
function stillEligibleLine(iteration: {
  repo: RepoSlug;
  ticket: Ticket;
}): string {
  return `- ${iteration.repo} #${iteration.ticket.number}: still ${READY_FOR_AGENT_LABEL} — the hand-back itself failed, relabel it yourself`;
}

/** What the developer may want to do about a ticket that keeps getting stopped short — said the same way everywhere it comes up. */
const CONSIDER_SPLITTING = "consider splitting it or giving it a larger size or model";

/** A limit-refused or budget-exhausted ticket whose salvage shows it has been stopped short repeatedly: worth the developer's attention, since it may need splitting or a larger size or model. */
function repeatedStopShortWaitingLine(
  iteration: { repo: RepoSlug; ticket: Ticket },
  stopShorts: number,
): string {
  return `- ${iteration.repo} #${iteration.ticket.number}: stopped short ${stopShorts} times in a row — ${CONSIDER_SPLITTING}`;
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
          ...(iteration.notReadied === undefined
            ? []
            : [notReadiedLine(iteration, iteration.notReadied)]),
          ...(iteration.notCommented === undefined
            ? []
            : [notCommentedLine(iteration, iteration.notCommented)]),
        ];
      }
      case "applied-review": {
        const waiting = appliedReviewWaitingLine(iteration);
        return [
          ...(waiting === undefined ? [] : [waiting]),
          ...(appliedReviewNotLabelled(iteration)
            ? [notLabelledLine(iteration, APPLIED_REVIEW_LABEL, iteration.notLabelled)]
            : []),
          ...(iteration.merge?.kind === "left-for-human" && iteration.merge.notLabelled !== undefined
            ? [notLabelledLine(iteration, READY_FOR_HUMAN_PULL_REQUEST_LABEL, iteration.merge.notLabelled)]
            : []),
        ];
      }
      case "rebased":
        return [rebasedWaitingLine(iteration)];
      case "spec-reviewed":
        return specReviewWaitingLine(iteration);
      // Closed outright, so nothing here waits on the developer — unless the
      // close itself failed, which leaves the ticket eligible and waiting the
      // same way a review or a rebase left open does.
      case "pull-request-resolved":
        return iteration.notClosed === undefined
          ? []
          : [pullRequestResolvedWaitingLine(iteration, iteration.notClosed)];
      // A limit refusal's or a provider failure's ticket waits on the
      // provider, not the developer — unless a limit refusal's or a budget
      // exhaustion's salvage shows the ticket has been stopped short
      // repeatedly, which the developer may want to act on by splitting it or
      // giving it a larger size or model.
      case "limit-refused":
      case "budget-exhausted": {
        const salvage = salvageOf(iteration.discard);
        return salvage !== undefined && salvage.stopShorts >= 2
          ? [repeatedStopShortWaitingLine(iteration, salvage.stopShorts)]
          : [];
      }
      case "provider-failed":
        return [];
      case "failed":
        return waitingOnFailure(iteration);
      // A blocking discovery's own hand-back: waits on the developer, worded
      // apart from a gave-up hand-back and an infrastructure failure, unless
      // an overlapping run already closed the ticket first or the tracker
      // refused the hand-back call itself.
      case "discovery-blocked": {
        const { handedBack } = iteration;
        if (handedBack.outcome === "refused") {
          return [stillEligibleLine(iteration)];
        }
        if (handedBack.outcome === "already-closed") {
          return [];
        }
        return [discoveryBlockedWaitingLine(iteration)];
      }
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
    return [
      reviewOutcome.clean
        ? `- ${repo}: ${handover.pullRequest} — reviewed, found nothing to flag${
            reviewOutcome.notReadied === undefined ? ", marked ready for review" : ""
          }`
        : `- ${repo}: ${handover.pullRequest} — reviewed, findings posted`,
    ];
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
    case "conflicting-model-labels":
    case "unusable-model-label": {
      const { problem, fix } = modelProblem(ticket, failure);
      return [
        `- ${repo} #${ticket.number}: relabelled ${READY_FOR_HUMAN_LABEL} — ${problem}, so ${fix}`,
      ];
    }
    case "unsettled-mergeability":
      return [
        `- ${repo} #${ticket.number}: relabelled ${READY_FOR_HUMAN_LABEL} — its pull request's mergeability never settled, so check whether it is still open`,
      ];
    case "unusable-size-label": {
      const { problem, fix } = sizeProblem(failure);
      return [
        `- ${repo} #${ticket.number}: relabelled ${READY_FOR_HUMAN_LABEL} — ${problem}, so ${fix}`,
      ];
    }
  }
}

/** What a cut-off or budget-exhausted iteration says about a branch its discard could not throw away. Empty when there was none, or it went cleanly. */
function keptBranchNote(iteration: CutOff | BudgetExhausted): string {
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
 * `salvagedBranchNote`, plus — for a limit refusal or a budget exhaustion
 * only — a warning once its ticket's own count of stop-shorts in a row
 * reaches two, since that is worth splitting it or giving it a larger size or
 * model over; at exactly one it stays quiet, a single stop-short being
 * unremarkable. An infrastructure failure never adds the warning here: its
 * own `stopShorts` only ever repeats what an earlier stop-short already
 * recorded, so this line's count would not be its own (see
 * `InfrastructureFailure.salvage`).
 */
function salvageNote(salvage: Salvaged | undefined): string {
  if (salvage === undefined) {
    return "";
  }
  const kept = salvagedBranchNote(salvage);
  return salvage.stopShorts < 2
    ? kept
    : `${kept} This ticket has been stopped short ${salvage.stopShorts} times in a row: ${CONSIDER_SPLITTING}.`;
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
    case "budget-exhausted":
      return `The run on ${iteration.repo} #${iteration.ticket.number} was stopped by its spend ceiling: ${withoutTrailingStop(iteration.words)}.${keptBranchNote(iteration)}${salvageNote(salvageOf(iteration.discard))}${transcriptNote(iteration.transcript)}`;
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
    case "spec-reviewed":
      return `${specReviewSummary(iteration)}${transcriptNote(iteration.review.transcript)}`;
    case "pull-request-resolved":
      return pullRequestResolvedSummary(iteration);
    case "finished":
      return `Worked ${iteration.repo}: ${landed(iteration)}.${queued(iteration)}${handbackNote(iteration)}${transcriptNote(iteration.run.transcript)}`;
    case "discovery-blocked": {
      const blocking = blockingDiscoveryClause(iteration.discoveryReport.routing);
      return `Worked ${iteration.repo} #${iteration.ticket.number}: the ticket is the problem, not the run — it filed ${blocking}.${transcriptNote(iteration.transcript)}`;
    }
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
  const { repo, ticket, clean, notClosed, notLabelled, notReadied, notCommented } = iteration;
  const pullRequest = ticket.pullRequest.url;
  switch (notClosed?.kind) {
    case undefined: {
      const posted = clean
        ? `Reviewed ${repo} #${ticket.number}: found nothing to flag on ${pullRequest}${
            notReadied === undefined ? ", now ready for review" : ""
          }.`
        : `Reviewed ${repo} #${ticket.number}: posted findings on ${pullRequest}.`;
      const labelNote =
        notLabelled === undefined
          ? ""
          : ` ${notLabelledNote(pullRequest, REVIEWED_LABEL, notLabelled)}.`;
      const readyNote =
        notReadied === undefined ? "" : ` ${notReadiedNote(pullRequest, notReadied)}.`;
      const commentNote =
        notCommented === undefined ? "" : ` ${notCommentedNote(pullRequest, notCommented)}.`;
      return `${posted}${labelNote}${readyNote}${commentNote}`;
    }
    case "check-failed":
      return `Reviewed ${repo} #${ticket.number}, but ${pullRequest} could not be checked for a posted review: ${withoutTrailingStop(notClosed.error)}. Still ${READY_FOR_AGENT_LABEL}: check ${pullRequest} and close it yourself.`;
    case "close-failed": {
      const posted = clean
        ? `found nothing to flag on ${pullRequest}`
        : `posted findings on ${pullRequest}`;
      return `Reviewed ${repo} #${ticket.number}: ${posted}, but the ticket could not be closed: ${withoutTrailingStop(notClosed.error)}. Still ${READY_FOR_AGENT_LABEL}: close it yourself.`;
    }
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
 * The sentence a clean review's refused ready-mark reads as, wherever it is
 * said: read at `notReadiedLine`, and inline at the end of `reviewSummary`'s
 * clean-outcome sentence — so a refused ready-mark is said one way rather
 * than in two wordings that drift apart from each other. CONTEXT.md's "Clean
 * review".
 */
function notReadiedNote(pullRequest: PullRequestUrl, { error }: NotReadied): string {
  return `${pullRequest} could not be marked ready for review: ${withoutTrailingStop(error)}; mark it ready yourself`;
}

/**
 * The Waiting-on-you line for a clean review iteration whose closed ticket's
 * pull request could not be marked ready. Read at the `reviewed` case in
 * `waitingSection`, once it has ruled out `notClosed`: the ready-mark is
 * tried only after the ticket has already closed, so the two never both
 * apply to the same iteration.
 */
function notReadiedLine(
  { repo, ticket }: { repo: RepoSlug; ticket: ReviewTicket },
  notReadied: NotReadied,
): string {
  return `- ${repo} #${ticket.number}: ${notReadiedNote(ticket.pullRequest.url, notReadied)}`;
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
  { repo, ticket, clean }: { repo: RepoSlug; ticket: ReviewTicket; clean?: boolean },
  notClosed: NotClosed,
): string {
  const still = `- ${repo} #${ticket.number}: still ${READY_FOR_AGENT_LABEL}`;
  switch (notClosed.kind) {
    case "check-failed":
      return `${still} — ${ticket.pullRequest.url} could not be checked for a posted review: ${withoutTrailingStop(notClosed.error)}; check it and close the ticket yourself`;
    case "close-failed": {
      const posted = clean
        ? `${ticket.pullRequest.url} was found clean`
        : `its findings are on ${ticket.pullRequest.url}`;
      return `${still} — ${posted}, but it could not be closed: ${withoutTrailingStop(notClosed.error)}; close it yourself`;
    }
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
 * Whether the merge gate merged `merge`'s own pull request — CONTEXT.md's
 * "Turboable", ADR 0009 — so `appliedReviewSummary` and
 * `appliedReviewWaitingLine` can say "ready for review" only where that is
 * still true, rather than of a pull request already merged. Names the
 * implementation ticket the merge closed, beside the pull request itself.
 */
function readyPhrase(merge: MergeGate | undefined): string {
  return merge?.kind === "merged"
    ? `merged #${merge.implementationTicket.number}, its branch deleted`
    : "now ready for review";
}

/**
 * What the merge gate left for the developer, appended to
 * `appliedReviewSummary`'s own clean-outcome sentence: empty when it never
 * merges — absent on a project that is not turbo, or `not-turboable` — since
 * neither adds anything to the sentence.
 */
function leftForHumanNote(pullRequest: PullRequestUrl, merge: MergeGate | undefined): string {
  if (merge?.kind !== "left-for-human") {
    return "";
  }
  const left = ` Left for you to merge: ${withoutTrailingStop(merge.reason)}.`;
  return merge.notLabelled === undefined
    ? left
    : `${left} ${notLabelledNote(pullRequest, READY_FOR_HUMAN_PULL_REQUEST_LABEL, merge.notLabelled)}.`;
}

/**
 * How an apply-review ticket's iteration reads to the developer: what it
 * applied and declined, that the pull request is ready for review or, on a
 * turbo project, what the merge gate came to — or why the loop could not
 * finish the ticket off.
 */
function appliedReviewSummary(iteration: AppliedReviewIteration): string {
  const { repo, ticket, notClosed, notLabelled, merge } = iteration;
  const pullRequest = ticket.pullRequest.url;
  const applied = `Applied review on ${repo} #${ticket.number}`;
  switch (notClosed?.kind) {
    case undefined: {
      const ready = `${applied}: ${answered(iteration)}, ${readyPhrase(merge)}.`;
      const labelled = notLabelled === undefined
        ? ready
        : `${ready} ${notLabelledNote(pullRequest, APPLIED_REVIEW_LABEL, notLabelled)}.`;
      return `${labelled}${leftForHumanNote(pullRequest, merge)}`;
    }
    case "check-failed":
      return `${applied}, but ${pullRequest} could not be checked for its answers: ${withoutTrailingStop(notClosed.error)}. Still ${READY_FOR_AGENT_LABEL}, and ${pullRequest} still a draft: check it, mark it ready and close the ticket yourself.`;
    case "ready-failed":
      return `${applied}: ${answered(iteration)}, but it could not be marked ready for review: ${withoutTrailingStop(notClosed.error)}. Still ${READY_FOR_AGENT_LABEL}: mark ${pullRequest} ready and close the ticket yourself.`;
    case "close-failed":
      return `${applied}: ${answered(iteration)}, now ready for review, but the ticket could not be closed: ${withoutTrailingStop(notClosed.error)}. Still ${READY_FOR_AGENT_LABEL}: close it yourself.`;
  }
}

/**
 * The Waiting-on-you line for an apply-review iteration: its pull request to
 * review or, on a turbo project, to merge yourself once the gate leaves it
 * for you — or the ticket left open. Absent once the merge gate has merged
 * the pull request itself: nothing is left for the developer to do.
 */
function appliedReviewWaitingLine(iteration: AppliedReviewIteration): string | undefined {
  const { repo, ticket, notClosed, merge } = iteration;
  const pullRequest = ticket.pullRequest.url;
  const still = `- ${repo} #${ticket.number}: still ${READY_FOR_AGENT_LABEL}`;
  switch (notClosed?.kind) {
    case undefined:
      if (merge?.kind === "merged") {
        return undefined;
      }
      return merge?.kind === "left-for-human"
        ? `- ${repo}: ${pullRequest} — left for you to merge: ${withoutTrailingStop(merge.reason)}`
        : `- ${repo}: ${pullRequest} — ready for review`;
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

/** A spec review iteration, with the ticket it worked. */
type SpecReviewedIteration = Attempt<SpecReviewTicket> & SpecReviewed;

/**
 * How a spec review ticket's iteration reads to the developer: that it ran
 * and reported. Unlike a review, apply-review or rebase ticket's own
 * success, a spec review never closes its ticket — its findings are the
 * hand-back comment itself, per CONTEXT.md's "Spec review ticket" — so this
 * names only that it ran, plus whatever `handedBackNow` says when the
 * hand-back itself was refused.
 */
function specReviewSummary(iteration: SpecReviewedIteration): string {
  const { repo, ticket, handedBack } = iteration;
  const now =
    handedBack.outcome === "refused"
      ? ` ${handedBackNow(`#${ticket.number}`, handedBack)}`
      : "";
  return `Spec-reviewed ${repo} #${ticket.number}: its findings are on the ticket.${now}`;
}

/**
 * The Waiting-on-you line for a spec review iteration: relabelled for a
 * human with its findings on the ticket, or still eligible when the
 * hand-back itself failed. Nothing when an overlapping run had already
 * closed the ticket — left exactly as it found it.
 */
function specReviewWaitingLine(iteration: SpecReviewedIteration): string[] {
  const { repo, ticket, handedBack } = iteration;
  if (handedBack.outcome === "refused") {
    return [stillEligibleLine(iteration)];
  }
  if (handedBack.outcome === "already-closed") {
    return [];
  }
  return [
    `- ${repo} #${ticket.number}: relabelled ${READY_FOR_HUMAN_LABEL} — its findings are on the ticket`,
  ];
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
      return `${which} was not worked, because ${withoutTrailingStop(modelProblem(iteration.ticket, failure).problem)}. ${now}`;
    case "conflicting-model-labels":
    case "unusable-model-label":
      return `${which} was not run, because ${withoutTrailingStop(modelProblem(iteration.ticket, failure).problem)}. ${now}`;
    case "unusable-size-label":
      return `${which} was not run, because ${withoutTrailingStop(sizeProblem(failure).problem)}. ${now}`;
    case "unsettled-mergeability":
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
