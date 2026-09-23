import { errorMessage } from "./error-message.ts";
import type {
  ClosingPullRequest,
  IssueTracker,
  OpenIssue,
  OpenIssues,
  RepoHost,
  RepoSlug,
  SubIssue,
  Ticket,
} from "./ports/index.ts";
import { isSupertask, specReviewTitle } from "./ports/index.ts";

/** The two ports one sweep reads and writes through, narrowed to what it calls. */
export interface SpecReviewSweepPorts {
  tracker: Pick<
    IssueTracker,
    "listSubIssues" | "createSpecReviewTicket" | "linkSpecReviewTicket"
  >;
  repoHost: Pick<RepoHost, "listPullRequestsClosingIssues">;
}

/**
 * One supertask a sweep could not finish a spec review for, and why: `action`
 * says which step refused — `"read"` for the sub-issue or pull-request reads
 * that come before either an open or a link is attempted, so neither is
 * asserted to have happened; `"open"` for a failed {@link
 * IssueTracker.createSpecReviewTicket}; `"link"` for a failed {@link
 * IssueTracker.linkSpecReviewTicket}, of a spec review that already exists.
 */
export interface SpecReviewSweepRefusal {
  supertask: Ticket;
  action: "read" | "open" | "link";
  error: string;
}

/** One floating spec review a sweep found already open, and linked to the supertask it reviews rather than opening a duplicate. */
export interface SpecReviewSweepLink {
  supertask: Ticket;
  specReview: Ticket;
}

/**
 * What sweeping one project came to: every spec review it opened, every one
 * it found floating and linked instead of opening a duplicate, and every
 * refusal it met along the way. A supertask that still has an open sub-issue,
 * or that already carries a spec review among its sub-issues — the guard,
 * per `CONTEXT.md`'s "Spec review sweep" — appears in none of the three,
 * since neither is something to report.
 */
export interface SpecReviewSweepOutcome {
  repo: RepoSlug;
  opened: Ticket[];
  linked: SpecReviewSweepLink[];
  refusals: SpecReviewSweepRefusal[];
}

/**
 * A spec review sweep of one project (`CONTEXT.md`'s "Spec review sweep",
 * issue #516): every supertask `openIssues` lists is asked, cheaply and from
 * `openIssues` alone, whether it still has an open sub-issue — a supertask
 * that does is left alone, no read spent on it. One that does not is asked,
 * through {@link IssueTracker.listSubIssues}, for every sub-issue it has ever
 * had, open or closed: a supertask that has never had one is left alone too
 * — there is nothing yet for a review to be about — and one that already
 * carries a spec review among them, open or closed, is the guard firing: at
 * most once per supertask, ever, since a live count of open sub-issues alone
 * would fire again the very next morning the spec review it opened closed.
 *
 * A supertask that clears both checks gets its spec review: its body names
 * every sub-issue `listSubIssues` found, and — read once here, at exactly
 * this instant, through {@link RepoHost.listPullRequestsClosingIssues} — the
 * branch and state of whichever of them has a pull request still unmerged.
 *
 * Before that spec review is opened, `openIssues` is searched once more —
 * this time for an issue carrying the spec-review label and the exact title
 * a spec review for this supertask is given, per {@link specReviewTitle} —
 * since a prior sweep can have created one and failed only at the link that
 * would have made it a sub-issue: `listSubIssues` reads by that relation
 * alone and is blind to a ticket the create half of the pair still left
 * floating. Found, it is linked instead of duplicated; not found, a spec
 * review opens exactly as it always has (`CONTEXT.md`'s "Spec review sweep",
 * issue #640).
 *
 * Nested supertasks need nothing special: each is itself just another ticket
 * `openIssues` lists carrying the supertask label, asked and guarded the same
 * way, and a nested one still open still counts as an open sub-issue of
 * whatever it is nested under — so the outer supertask's own spec review
 * waits until the inner one, review included, is closed by hand.
 *
 * Best effort per supertask: a refused read or write is recorded in the
 * outcome and the sweep carries on to the next supertask, never throwing.
 */
export async function specReviewSweep(
  ports: SpecReviewSweepPorts,
  repo: RepoSlug,
  openIssues: OpenIssues,
): Promise<SpecReviewSweepOutcome> {
  const opened: Ticket[] = [];
  const linked: SpecReviewSweepLink[] = [];
  const refusals: SpecReviewSweepRefusal[] = [];
  // Read at most once per sweep, lazily: a sweep that opens nothing still
  // spends nothing, and every supertask that does need it this scan shares
  // the one `gh pr list`, per `CONTEXT.md`'s "Spec review sweep".
  let closingPullRequests: Promise<readonly ClosingPullRequest[]> | undefined;

  for (const { ticket: supertask } of openIssues.issues) {
    if (!isSupertask(supertask) || hasOpenSubIssue(supertask, openIssues.issues)) {
      continue;
    }

    let subIssues: SubIssue[];
    try {
      // `openIssues` alone is only the cheap pre-filter above: a truncated
      // backlog or a sub-issue in another repo can leave it blind to one
      // still open, so `subIssues` — authoritative, per `CONTEXT.md`'s "Spec
      // review sweep" — is asked again before the guard trusts it.
      subIssues = await ports.tracker.listSubIssues(supertask);
      if (
        subIssues.length === 0 ||
        subIssues.some(alreadySpecReviewed) ||
        subIssues.some((sub) => !sub.closed)
      ) {
        continue;
      }
    } catch (error) {
      // Neither an open nor a link has been attempted yet, so the refusal
      // must not read as either — `"read"` is the whole story so far.
      refusals.push({ supertask, action: "read", error: errorMessage(error) });
      continue;
    }

    // `subIssues` alone cannot see one a prior sweep opened but never
    // linked — it carries no sub-issue relation to find it by — so
    // `openIssues`, already read once for the whole sweep, is searched by
    // title and label instead. Unlike the `listSubIssues` guard above, this
    // search has no authoritative fallback: `openIssues` is newest-first
    // and capped, so a floating spec review is missed only where the
    // backlog is truncated and it has sat unlinked long enough to fall off
    // the read — an authoritative search would cost a `gh issue list`
    // filtered by label and title per supertask, every sweep, to catch a
    // case this narrow.
    const floating = findFloatingSpecReview(supertask, openIssues.issues);
    if (floating !== undefined) {
      try {
        // `body` is composed only if the tracker actually falls back to it —
        // native sub-issues never call it, so a link that succeeds the
        // ordinary way never spends the `gh pr list` disclosure read below,
        // and never overwrites `floating`'s own existing text with it.
        await ports.tracker.linkSpecReviewTicket(floating, supertask, async () => {
          closingPullRequests ??= ports.repoHost.listPullRequestsClosingIssues(repo);
          return specReviewBody(supertask, subIssues, await closingPullRequests);
        });
        linked.push({ supertask, specReview: floating });
      } catch (error) {
        refusals.push({ supertask, action: "link", error: errorMessage(error) });
      }
      continue;
    }

    try {
      closingPullRequests ??= ports.repoHost.listPullRequestsClosingIssues(repo);
      const body = specReviewBody(supertask, subIssues, await closingPullRequests);
      const specReview = await ports.tracker.createSpecReviewTicket(supertask, body);
      opened.push(specReview);
    } catch (error) {
      refusals.push({ supertask, action: "open", error: errorMessage(error) });
    }
  }

  return { repo, opened, linked, refusals };
}

/**
 * Whether `ticket` has an open sub-issue among `issues` — of any kind,
 * unlike `selection.ts`'s own `hasNonPullRequestSubIssue`: a review, an
 * apply-review or a rebase ticket still open counts here exactly as an
 * implementation ticket would, per `CONTEXT.md`'s "Spec review sweep" — a
 * spec review is not pull-request-bound, so it counts toward its
 * supertask's sub-issues like any other.
 */
function hasOpenSubIssue(ticket: Ticket, issues: readonly OpenIssue[]): boolean {
  return issues.some((issue) => issue.parent === ticket.number);
}

/** Whether `sub` is a spec review already opened for its supertask — the guard itself. */
function alreadySpecReviewed(sub: SubIssue): boolean {
  return sub.ticket.specReview === true;
}

/**
 * The spec review `specReviewSweep` already opened for `supertask`, if one
 * is sitting among `issues` unlinked — carrying the spec-review label, the
 * exact title {@link specReviewTitle} gives a spec review for `supertask`,
 * and no parent of its own, so a spec review someone hand-linked to a
 * different supertask is never mistaken for a match and re-parented.
 */
function findFloatingSpecReview(
  supertask: Ticket,
  issues: readonly OpenIssue[],
): Ticket | undefined {
  const title = specReviewTitle(supertask);
  return issues.find(
    (issue) =>
      issue.ticket.specReview === true &&
      issue.ticket.title === title &&
      issue.parent === undefined,
  )?.ticket;
}

/**
 * The body a spec review is opened with: names `supertask`, then every one
 * of `subIssues` — all of them closed, or `specReviewSweep` would never have
 * reached here — and, for each whose pull request `closingPullRequests`
 * names as not merged, that pull request's own number, branch and state.
 * Silent about the rest, per `CONTEXT.md`'s "Spec review sweep": a sub-issue
 * closed with its pull request merged, or with none at all, reads as intent
 * rather than as a gap.
 */
function specReviewBody(
  supertask: Ticket,
  subIssues: readonly SubIssue[],
  closingPullRequests: readonly ClosingPullRequest[],
): string {
  return [
    `Reviews #${supertask.number}, now that every sub-issue has closed.`,
    "",
    "Sub-issues:",
    "Each pull request fact below was read once, from the repo host, the moment this ticket opened; a sub-issue named with none either merged or never had a pull request.",
    ...subIssues.map((sub) => subIssueLine(sub, closingPullRequests)),
  ].join("\n");
}

/** One `- #N` bullet `specReviewBody` names a sub-issue with, per its unmerged pull request if it has one. */
function subIssueLine(
  sub: SubIssue,
  closingPullRequests: readonly ClosingPullRequest[],
): string {
  const pullRequest = closingPullRequests.find((candidate) =>
    candidate.closesIssues.includes(sub.ticket.number),
  );
  if (pullRequest === undefined || pullRequest.state === "merged") {
    return `- #${sub.ticket.number}`;
  }
  return `- #${sub.ticket.number}: pull request #${pullRequest.number} on branch \`${pullRequest.branch}\`, ${pullRequest.state}`;
}
