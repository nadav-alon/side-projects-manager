import type {
  IssueNumber,
  IssueTracker,
  OpenIssue,
  Priority,
  ProjectState,
  RegisteredProject,
  RepoSlug,
  Store,
  Ticket,
  TicketKind,
  TicketPriority,
} from "./ports/index.ts";
import {
  backlogIn,
  isBlocked,
  isPullRequestTicket,
  isSupertask,
  ticketKind,
  ticketPrioritiesIn,
} from "./ports/index.ts";
import {
  conflictSweep,
  type ConflictSweepOutcome,
  type ConflictSweepRepoHost,
} from "./conflict-sweep.ts";
import {
  specReviewSweep,
  type SpecReviewSweepOutcome,
  type SpecReviewSweepPorts,
} from "./spec-review-sweep.ts";
import type { WorkedTickets } from "./worked-today.ts";

/** The project an iteration works, and the ticket it works there. */
export interface Selection {
  project: RegisteredProject;
  ticket: Ticket;
}

/** What became of one registered project. */
export type ProjectVerdict =
  /** Paused in the registry, so not considered at all. */
  | "paused"
  /** Considered, and its backlog held nothing eligible. */
  | "no-eligible-tickets"
  /**
   * Considered, and at least one eligible ticket in its backlog was already
   * worked today, with nothing selectable left over — whatever remains is
   * blocked or a supertask. Distinct from `no-eligible-tickets` because a
   * backlog is not empty just because nothing in it is pickable today.
   */
  | "already-worked-today"
  /**
   * Had an eligible ticket, but another project outranked it this iteration —
   * a review elsewhere, an explicit priority, or simply having waited longer.
   * Not skipped for good: a later iteration in the same invocation, or
   * tomorrow's, may still pick it.
   */
  | "deferred"
  /** Considered and selected: the project this iteration works. */
  | "selected";

/** One registered project, and what the invocation made of it. */
export interface ProjectOutcome {
  repo: RepoSlug;
  verdict: ProjectVerdict;
  /**
   * When an iteration last worked it, as the invocation found it. A project
   * this invocation went on to work still reads as it did beforehand, so the
   * report says what was true when the decision was made.
   */
  lastWorkedAt?: Date;
  /**
   * Tickets this scan found carrying ready-for-agent but passed over for
   * being a supertask, in backlog order. What makes a backlog that looked
   * full but yielded nothing explicable, rather than indistinguishable from
   * one that was simply empty.
   */
  supertasks?: Ticket[];
  /**
   * Tickets this scan found carrying ready-for-agent but passed over because
   * an open ticket blocks them, in backlog order — for the same reason as
   * `supertasks`.
   */
  blocked?: Ticket[];
  /**
   * Tickets this scan found with an open sub-issue that is not a pull
   * request ticket, yet no supertask label — a likely missed label, in
   * listing order. Read over every open issue, whatever its own triage
   * label or whether it was already worked this invocation, since a
   * ready-for-human spec is exactly the un-migrated container the label
   * needs applying to. Reported, not skipped: unlike a supertask or a
   * blocked ticket, a wrong guess here costs one summary line, not a wrong
   * selection, so the ticket stays exactly as selectable as it would
   * otherwise be.
   */
  missingSupertaskLabel?: Ticket[];
  /**
   * Set when this project's backlog held more eligible tickets than the read
   * kept — regardless of verdict, since a project outranked this morning can
   * still be the one whose backlog needs thinning.
   */
  backlogTruncated?: true;
}

/**
 * The three ports selection uses: two it reads, one it writes through.
 * `tracker` and `store` are read fresh on every `next`, never cached, so a
 * project the developer adds or a ticket that changes mid-invocation is what
 * the next scan sees. `repoHost` is what each scan's conflict sweep and spec
 * review sweep write through (CONTEXT.md's "Conflict sweep" and "Spec review
 * sweep", ADR 0007 and issue #516): the writes selection makes, alongside
 * its reads — narrowed to the verbs the two sweeps call between them.
 */
export interface SelectionPorts {
  tracker: Pick<
    IssueTracker,
    | "listOpenIssues"
    | "listSubIssues"
    | "createSpecReviewTicket"
    | "linkSpecReviewTicket"
  >;
  store: Pick<Store, "loadRegistry">;
  repoHost: ConflictSweepRepoHost & SpecReviewSweepPorts["repoHost"];
}

/**
 * The invocation's whole view of selection: each iteration's turn to ask
 * `next` for the project and ticket it should work, or nothing left to
 * select, and — once the invocation is done asking — `verdicts` for every
 * registered project's final word, in registry order.
 *
 * A single instance is built once per invocation and lives for its whole
 * length, because the glue that makes selection behave correctly across
 * iterations is exactly what an instance holds: a project selected on an
 * earlier `next` keeps that verdict even once its ticket is excluded from a
 * later scan, and a project's place in `verdicts` comes from when its repo
 * was first seen, not from whichever scan happens to run last.
 */
export interface InvocationSelection {
  /**
   * The project and ticket the next iteration should work, or `undefined`
   * once no non-paused project has an eligible, not-yet-worked ticket.
   *
   * Every non-paused project is scanned, never just enough to find one:
   * priority can make a project registered last outrank one registered
   * first, so the only way to know which project wins is to have looked at
   * all of them.
   */
  next(): Promise<Selection | undefined>;
  /**
   * Every registered project seen by any call to `next` so far, in the order
   * each was first seen, with why it was skipped — or, once it has been,
   * that it was selected, which then sticks even once a later scan finds
   * nothing left of its backlog to select.
   */
  verdicts(): ProjectOutcome[];
  /**
   * Every conflict sweep run by any call to `next` so far, in the order each
   * ran. One `next` sweeps every non-paused project once, so an invocation
   * that calls `next` several times carries several outcomes for the same
   * project — left for `summary.ts` to deduplicate, per its own doc.
   */
  sweeps(): ConflictSweepOutcome[];
  /**
   * Every spec review sweep run by any call to `next` so far, in the order
   * each ran — one per non-paused project per scan, as `sweeps` is for the
   * conflict sweep. A supertask a sweep opened a spec review for is not one a
   * later scan the same invocation finds again: its own new sub-issue is
   * what the next scan's fresh `listOpenIssues` sees, so — unlike the
   * conflict sweep's own changes — nothing here is ever the same supertask
   * twice.
   */
  specReviewSweeps(): SpecReviewSweepOutcome[];
}

/**
 * Builds one invocation's selection, starting from `projectStates` and
 * `worked` as the invocation opened with. Both are read live rather than
 * copied: `projectStates` is the same map `morningLoop` records a finished
 * run's cost into, and `worked` is the same tracker it calls `record` and
 * `unrecord` on between iterations, so a change either makes between two
 * calls to `next` is exactly what the next scan sees.
 */
export function invocationSelection(
  ports: SelectionPorts,
  projectStates: ReadonlyMap<RepoSlug, ProjectState>,
  worked: WorkedTickets,
): InvocationSelection {
  // Registry order falls out of insertion order for free: a `Map` iterates
  // in the order its keys were first set, and a repo is always set here the
  // first time it is seen across every scan `next` makes — a project
  // outranked into "deferred" on the first scan and never asked about again
  // still keeps its place, since re-setting an existing key never moves it.
  const outcomesByRepo = new Map<RepoSlug, ProjectOutcome>();
  // Appended to by every scan, never deduplicated here: `sweeps()` hands the
  // whole run to `summary.ts`, which is what dedupes a change or a refusal
  // met by more than one scan.
  const sweepOutcomes: ConflictSweepOutcome[] = [];
  // Appended to by every scan, same as `sweepOutcomes` — but never carries
  // the same supertask twice, per `specReviewSweeps`'s own doc, so nothing
  // here needs deduplicating the way `sweepOutcomes` does.
  const specReviewSweepOutcomes: SpecReviewSweepOutcome[] = [];

  return {
    next: () =>
      scan(
        ports,
        projectStates,
        worked,
        outcomesByRepo,
        sweepOutcomes,
        specReviewSweepOutcomes,
      ),
    verdicts: () => [...outcomesByRepo.values()],
    sweeps: () => [...sweepOutcomes],
    specReviewSweeps: () => [...specReviewSweepOutcomes],
  };
}

/**
 * One project with an eligible ticket, as far as selection is concerned: the
 * project itself, the ticket selection would work on its behalf, that
 * ticket's kind, and this scan's findings — everything the ordering rule
 * needs and everything the winner's outcome is rebuilt from, nothing asked
 * of the tracker twice for.
 */
interface Candidate {
  project: RegisteredProject;
  ticket: Ticket;
  kind: TicketKind;
  findings: ScanFindings;
  priority?: Priority;
  lastWorkedAt?: Date;
}

/**
 * What scanning one project's backlog found, whatever its verdict: the
 * tickets passed over, the tickets flagged for a likely missed supertask
 * label — never passed over on account of it — and whether the listing was
 * truncated.
 */
interface ScanFindings {
  supertasks: Ticket[];
  blocked: Ticket[];
  missingSupertaskLabel: Ticket[];
  backlogTruncated: boolean;
}

/**
 * One scan of the registry: sweeps every non-paused project for conflicts
 * (CONTEXT.md's "Conflict sweep", ADR 0007) and for a supertask whose
 * sub-issues have all just closed (CONTEXT.md's "Spec review sweep", issue
 * #516), asks its backlog for a candidate ticket, hands the best one to
 * `bestCandidate`, then folds this scan's outcomes into the invocation's
 * sticky `outcomesByRepo` before answering with the winner, if any.
 *
 * A paused project is passed over without asking the tracker or the repo
 * host anything, because paused means never considered — and never swept.
 * A project left with no selectable ticket reads as already worked today
 * when at least one eligible ticket is in `worked`, and reads the same as an
 * empty backlog otherwise — including when every ticket left is merely
 * blocked or a supertask. Either way it was still swept: both sweeps run
 * whether or not anything turns out eligible.
 */
async function scan(
  ports: SelectionPorts,
  projectStates: ReadonlyMap<RepoSlug, ProjectState>,
  worked: WorkedTickets,
  outcomesByRepo: Map<RepoSlug, ProjectOutcome>,
  sweepOutcomes: ConflictSweepOutcome[],
  specReviewSweepOutcomes: SpecReviewSweepOutcome[],
): Promise<Selection | undefined> {
  const outcomes = new Map<RepoSlug, ProjectOutcome>();
  const candidates: Candidate[] = [];

  for (const project of await ports.store.loadRegistry()) {
    const projectState = projectStates.get(project.repo);

    if (project.paused) {
      outcomes.set(project.repo, outcome(project.repo, "paused", projectState));
      continue;
    }

    // Worked out over every open issue read, before `backlogIn` keeps only the
    // eligible ones: a spec left ready-for-human, or a ticket passed over as
    // blocked, still passes its priority label on. Reassigned below, only on
    // a scan whose spec review sweep opened something, so the ticket it just
    // opened is selectable this same scan rather than only the next.
    let open = await ports.tracker.listOpenIssues(project.repo);
    // The same read the sweep is told about, rather than a second listing —
    // one project is never read twice for the same scan. `next` must not be
    // called concurrently: two scans in flight would sweep the same project
    // twice at once.
    //
    // A rebase ticket takes a moment to exist once posted: `open`, read at
    // the top of this scan, may still show no open rebase ticket for a pull
    // request an earlier scan of this same invocation already commented on.
    // `alreadyPosted` — every url this invocation has already commented on,
    // regardless of project — holds `/rebase` to once per pull request
    // without a second tracker read.
    const alreadyPosted = new Set(
      sweepOutcomes.flatMap((swept) =>
        swept.changes
          .filter((change) => change.action === "commented")
          .map((change) => change.pullRequest),
      ),
    );
    sweepOutcomes.push(
      await conflictSweep(
        ports.repoHost,
        project.repo,
        project.turbo,
        open,
        alreadyPosted,
      ),
    );
    // Before selection, same as the conflict sweep, and over the same
    // listing: a supertask this opens a spec review for is a fact about the
    // repo, not about which ticket this scan goes on to select.
    const specReviewsThisScan = await specReviewSweep(ports, project.repo, open);
    specReviewSweepOutcomes.push(specReviewsThisScan);
    // Per `CONTEXT.md`'s "Spec review sweep": born selectable the same
    // morning it is opened. Everything below reads `open`, so a scan that
    // just opened one re-reads it here — the one extra tracker read a
    // supertask completing costs, and only on the mornings one does.
    if (specReviewsThisScan.opened.length > 0) {
      open = await ports.tracker.listOpenIssues(project.repo);
    }
    const ticketPriorities = ticketPrioritiesIn(open);
    const { tickets, truncated: backlogTruncated } = backlogIn(open);
    const backlog = tickets.filter((ticket) => !worked.passesOver(ticket));
    // A ticket carrying the supertask label is a container, not work of its
    // own — set aside here rather than in the tracker's query, so the rule
    // can be exercised against the fake, which reads the same label, and the
    // summary can still name what it passed over. A ticket an open ticket
    // blocks is set aside the same way: its work builds on work not yet
    // done.
    const supertasks: Ticket[] = [];
    const blocked: Ticket[] = [];
    const selectable: Ticket[] = [];
    for (const ticket of backlog) {
      if (isSupertask(ticket)) {
        supertasks.push(ticket);
      } else if (isBlocked(ticket)) {
        blocked.push(ticket);
      } else {
        selectable.push(ticket);
      }
    }
    // Read over every open issue, not just this scan's backlog: the likely
    // missed label is as real on a ready-for-human spec, or on a ticket
    // already worked this invocation, as on one selection would otherwise
    // pick up. Never what excludes a ticket from `selectable`: a wrong guess
    // here costs one summary line, not a wrong selection, unlike
    // `isSupertask` itself.
    const missingSupertaskLabel = open.issues.flatMap(({ ticket }) =>
      !isSupertask(ticket) && hasNonPullRequestSubIssue(ticket, open.issues)
        ? [ticket]
        : [],
    );
    const findings: ScanFindings = {
      supertasks,
      blocked,
      missingSupertaskLabel,
      backlogTruncated,
    };
    // A review in the same backlog as its parent ticket is worked before it.
    const ticket = bestTicket(selectable, ticketPriorities);

    if (ticket === undefined) {
      // Nothing here is selectable, but that is only "already worked today"
      // when `worked` is why: at least one eligible ticket this scan found is
      // in it. A backlog left with nothing but blocked tickets or supertasks,
      // none of them in `worked`, reads the same as an empty one.
      const verdict =
        tickets.length > backlog.length
          ? "already-worked-today"
          : "no-eligible-tickets";
      outcomes.set(
        project.repo,
        outcome(project.repo, verdict, projectState, findings),
      );
      continue;
    }

    candidates.push({
      project,
      ticket,
      kind: ticketKind(ticket),
      findings,
      ...(project.priority !== undefined && { priority: project.priority }),
      ...(projectState?.lastWorkedAt !== undefined && {
        lastWorkedAt: projectState.lastWorkedAt,
      }),
    });
    outcomes.set(
      project.repo,
      outcome(project.repo, "deferred", projectState, findings),
    );
  }

  const winner = bestCandidate(candidates);
  if (winner !== undefined) {
    // Rebuilt from the candidate itself, not looked up: what the scan found,
    // passed-over tickets and a truncated backlog included, is as true of the
    // winner as of any project it outranked.
    outcomes.set(
      winner.project.repo,
      outcome(
        winner.project.repo,
        "selected",
        projectStates.get(winner.project.repo),
        winner.findings,
      ),
    );
  }

  // A project keeps its "selected" verdict once it has one: a later scan run
  // after its ticket is excluded would otherwise read it right back to
  // "no eligible tickets" and hide that its turn already came. Applying that
  // here, rather than in `outcome`, is what makes a repo already marked
  // "selected" immune to this scan even when it wins again — its first
  // "selected" outcome is the one the invocation reports.
  for (const found of outcomes.values()) {
    if (outcomesByRepo.get(found.repo)?.verdict !== "selected") {
      outcomesByRepo.set(found.repo, found);
    }
  }

  return winner === undefined
    ? undefined
    : { project: winner.project, ticket: winner.ticket };
}

/**
 * Whether `ticket` has an open sub-issue among `issues` that is not a pull
 * request ticket: the fact behind a likely missed supertask label. Read over
 * the whole listing rather than `backlog`, since a sub-issue that has not
 * itself been triaged onto the loop still makes its parent a container.
 * Narrowed to non-pull-request sub-issues so a handed-back ticket with an
 * open review — normal, not a missed label — never trips it.
 */
function hasNonPullRequestSubIssue(
  ticket: Ticket,
  issues: readonly OpenIssue[],
): boolean {
  return issues.some(
    (issue) => issue.parent === ticket.number && !isPullRequestTicket(issue.ticket),
  );
}

/**
 * The one ticket `backlog` offers selection, within a single project: a
 * rebase ticket before an apply-review ticket before a review ticket before a
 * spec review ticket before any implementation ticket, since finishing beats
 * starting and a review already written is nearer finished than one not yet
 * written — and a review applied to a branch that cannot merge has to be
 * rebased afterwards anyway; among implementation tickets, ticket priority
 * ascending — as `ticketPriorities` holds it by issue number, never a
 * ticket's own priority label — with a ticket absent from it sorting after
 * every ticket present; and, ties still standing, the oldest ticket — the
 * lowest issue number — so the order the tracker happened to return them in
 * never matters. Two tickets of the same non-implementation kind go straight
 * to the oldest ticket: ticket priority orders implementation tickets only,
 * and a pull request ticket or a spec review ticket alike — each a sub-issue
 * of the ticket it is about — inherits its parent's priority as such rather
 * than carrying a rank of its own.
 */
function bestTicket(
  backlog: Ticket[],
  ticketPriorities: ReadonlyMap<IssueNumber, TicketPriority>,
): Ticket | undefined {
  return [...backlog].sort((a, b) =>
    compareTickets(a, b, ticketPriorities),
  )[0];
}

/**
 * Where each ticket kind stands in the order selection works them, lowest
 * first. A record rather than a list, so a kind added to `TicketKind` fails
 * to compile until it is given a place here.
 */
const SELECTION_RANK: Readonly<Record<TicketKind, number>> = {
  rebase: 0,
  "apply-review": 1,
  review: 2,
  "spec-review": 3,
  implementation: 4,
};

/** Ascending by each kind's `SELECTION_RANK`. */
function compareKinds(a: TicketKind, b: TicketKind): number {
  return SELECTION_RANK[a] - SELECTION_RANK[b];
}

function compareTickets(
  a: Ticket,
  b: Ticket,
  ticketPriorities: ReadonlyMap<IssueNumber, TicketPriority>,
): number {
  const kind = ticketKind(a);
  const kindOrder = compareKinds(kind, ticketKind(b));
  if (kindOrder !== 0) {
    return kindOrder;
  }
  if (kind !== "implementation") {
    return a.number - b.number;
  }
  const byPriority = absentLast(
    ticketPriorities.get(a.number),
    ticketPriorities.get(b.number),
  );
  if (byPriority !== 0) {
    return byPriority;
  }
  return a.number - b.number;
}

/**
 * Selection's ordering rule, applied as one comparison rather than as
 * separate passes: rebases before apply-reviews before reviews before spec
 * reviews before implementations, then explicit priority, then least
 * recently worked. Each level only breaks ties the level before it left
 * standing, so a pull request ticket or a spec review ticket is never
 * outranked by priority and priority is never outranked by how long a
 * project has waited.
 *
 * A project without a priority sorts after every project that has one, and a
 * project never worked sorts before every project that has been — it is, by
 * definition, the one that has waited longest.
 */
function bestCandidate(candidates: Candidate[]): Candidate | undefined {
  return [...candidates].sort(compareCandidates)[0];
}

function compareCandidates(a: Candidate, b: Candidate): number {
  const kindOrder = compareKinds(a.kind, b.kind);
  if (kindOrder !== 0) {
    return kindOrder;
  }
  const byPriority = absentLast(a.priority, b.priority);
  if (byPriority !== 0) {
    return byPriority;
  }
  return leastRecentlyWorkedFirst(a.lastWorkedAt, b.lastWorkedAt);
}

/**
 * Ascending by a project's `Priority` or by a ticket's `TicketPriority`, never
 * one against the other, with an absent value sorting after every present
 * one. Not via arithmetic on a sentinel, since `Infinity - Infinity` is `NaN`,
 * and a comparator that can return `NaN` leaves `Array.prototype.sort` free to
 * return either order.
 */
function absentLast(a: Priority | undefined, b: Priority | undefined): number;
function absentLast(
  a: TicketPriority | undefined,
  b: TicketPriority | undefined,
): number;
function absentLast(
  a: Priority | TicketPriority | undefined,
  b: Priority | TicketPriority | undefined,
): number {
  if (a === undefined) {
    return b === undefined ? 0 : 1;
  }
  if (b === undefined) {
    return -1;
  }
  return a - b;
}

function leastRecentlyWorkedFirst(
  a: Date | undefined,
  b: Date | undefined,
): number {
  if (a === undefined) {
    return b === undefined ? 0 : -1;
  }
  if (b === undefined) {
    return 1;
  }
  return a.getTime() - b.getTime();
}

function outcome(
  repo: RepoSlug,
  verdict: ProjectVerdict,
  state: ProjectState | undefined,
  {
    supertasks = [],
    blocked = [],
    missingSupertaskLabel = [],
    backlogTruncated = false,
  }: Partial<ScanFindings> = {},
): ProjectOutcome {
  const lastWorkedAt = state?.lastWorkedAt;
  return {
    repo,
    verdict,
    ...(lastWorkedAt !== undefined && { lastWorkedAt }),
    ...(supertasks.length > 0 && { supertasks }),
    ...(blocked.length > 0 && { blocked }),
    ...(missingSupertaskLabel.length > 0 && { missingSupertaskLabel }),
    ...(backlogTruncated && { backlogTruncated: true }),
  };
}
