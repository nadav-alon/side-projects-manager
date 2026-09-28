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
import { isSupertask, sameRepo, specReviewTitle, ticketReference } from "./ports/index.ts";

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
 * every sub-issue `listSubIssues` found, and — read here, at exactly this
 * instant, through {@link RepoHost.listPullRequestsClosingIssues}, once per
 * repo across the supertask's own repo and every other repo a sub-issue
 * lives in — the branch and state of whichever of them has a pull request
 * still unmerged, in its own repo.
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
  // Read at most once per repo per sweep, lazily: a sweep that opens nothing
  // still spends nothing, and every supertask that does need a given repo
  // this scan shares the one `gh pr list` for it, per `CONTEXT.md`'s "Spec
  // review sweep".
  const closingPullRequestReads = new Map<RepoSlug, Promise<readonly ClosingPullRequest[]>>();

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
          const closingPullRequests = await closingPullRequestsForSupertask(
            ports,
            closingPullRequestReads,
            supertask.repo,
            subIssues,
          );
          return specReviewBody(supertask, subIssues, closingPullRequests);
        });
        linked.push({ supertask, specReview: floating });
      } catch (error) {
        refusals.push({ supertask, action: "link", error: errorMessage(error) });
      }
      continue;
    }

    try {
      const closingPullRequests = await closingPullRequestsForSupertask(
        ports,
        closingPullRequestReads,
        supertask.repo,
        subIssues,
      );
      const body = specReviewBody(supertask, subIssues, closingPullRequests);
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
 * One {@link ClosingPullRequest} paired with the repo it was read from —
 * lost the moment it leaves {@link RepoHost.listPullRequestsClosingIssues},
 * whose result carries no repo of its own, per `ClosingPullRequest`'s doc
 * comment. `subIssueLine` needs it back: a pull request read from a
 * sub-issue's own repo, rather than the supertask's, is named `owner/repo#N`
 * in the spec review body the same way the sub-issue itself is.
 */
interface RepoClosingPullRequest {
  repo: RepoSlug;
  pullRequest: ClosingPullRequest;
}

/**
 * Every closing pull request a spec review for `supertask` could name:
 * read, through `closingPullRequestReads` — shared across every supertask
 * this sweep still has to look at, so a repo common to more than one of
 * them is asked for exactly once — from `supertaskRepo` and from every
 * other repo `subIssues` lives in. A cross-repo sub-issue's own pull
 * request usually lives in that sub-issue's repo rather than
 * `supertaskRepo`, so both are read and `subIssueLine` matches against
 * the union. A failed read of `supertaskRepo` itself still refuses the
 * supertask, exactly as it always has; a failed read of any other repo
 * falls back to no pull requests from it, so one repo a sweep can't read
 * — its credential, say — costs only that repo's disclosure, the same
 * bare bullet a sub-issue with no pull request at all gets, rather than
 * refusing every supertask that happens to share it.
 */
async function closingPullRequestsForSupertask(
  ports: SpecReviewSweepPorts,
  closingPullRequestReads: Map<RepoSlug, Promise<readonly ClosingPullRequest[]>>,
  supertaskRepo: RepoSlug,
  subIssues: readonly SubIssue[],
): Promise<readonly RepoClosingPullRequest[]> {
  const repos = new Set<RepoSlug>([supertaskRepo]);
  for (const sub of subIssues) {
    repos.add(sub.ticket.repo);
  }
  const perRepo = await Promise.all(
    [...repos].map(async (repo) => {
      let read = closingPullRequestReads.get(repo);
      if (read === undefined) {
        read = ports.repoHost.listPullRequestsClosingIssues(repo);
        closingPullRequestReads.set(repo, read);
      }
      if (repo !== supertaskRepo) {
        try {
          return (await read).map((pullRequest) => ({ repo, pullRequest }));
        } catch {
          return [];
        }
      }
      return (await read).map((pullRequest) => ({ repo, pullRequest }));
    }),
  );
  return perRepo.flat();
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
  closingPullRequests: readonly RepoClosingPullRequest[],
): string {
  return [
    `Reviews #${supertask.number}, now that every sub-issue has closed.`,
    "",
    "Sub-issues:",
    "Each pull request fact below was read once, from the repo host, the moment this ticket opened; a sub-issue named with none either merged or never had a pull request.",
    ...subIssues.map((sub) => subIssueLine(supertask.repo, sub, closingPullRequests)),
  ].join("\n");
}

/**
 * One bullet `specReviewBody` names a sub-issue with, per its unmerged pull
 * request if it has one. Named `owner/repo#N`, per `ticketReference`,
 * where `sub` lives in another repo than `supertaskRepo`: a bare `#N` would
 * resolve against the spec review's own repo — `supertaskRepo` — and name the
 * wrong issue there. The pull request search is scoped the same way: a
 * candidate only matches where its `closesIssues` names `sub`'s own repo and
 * number together, since a cross-repo sub-issue's number can coincide with an
 * unrelated issue `closesIssues` names in `supertaskRepo`. The repo names are
 * matched with `sameRepo`, not `===`: `closesIssues` carries GitHub's own
 * canonical casing, which need not match the configured repo slug's. Where
 * more than one candidate matches — a pull request elsewhere naming `sub` in
 * its own `closesIssues`, alongside the pull request that actually lives in
 * `sub`'s own repo — the one read from `sub`'s own repo wins: that is where
 * its own pull request actually lives, so preferring it over one merely
 * naming it from afar is what keeps a stray cross-repo close reference from
 * shadowing the pull request this bullet is really about.
 *
 * The matched pull request's own number is written the same rule
 * `referenceFrom` writes `sub`'s own name with: bare where
 * `closingPullRequestsForSupertask` read it from `supertaskRepo`,
 * `owner/repo#N` where it read it from `sub`'s own repo instead — a bare
 * number would otherwise resolve against `supertaskRepo`, same as the
 * sub-issue's own would.
 */
function subIssueLine(
  supertaskRepo: RepoSlug,
  sub: SubIssue,
  closingPullRequests: readonly RepoClosingPullRequest[],
): string {
  const name = referenceFrom(supertaskRepo, sub.ticket);
  const candidates = closingPullRequests.filter(({ pullRequest }) =>
    pullRequest.closesIssues.some(
      (closed) =>
        sameRepo(closed.repo, sub.ticket.repo) && closed.number === sub.ticket.number,
    ),
  );
  const match =
    candidates.find(({ repo }) => repo === sub.ticket.repo) ?? candidates[0];
  if (match === undefined || match.pullRequest.state === "merged") {
    return `- ${name}`;
  }
  const { repo, pullRequest } = match;
  const number = referenceFrom(supertaskRepo, { repo, number: pullRequest.number });
  return `- ${name}: pull request ${number} on branch \`${pullRequest.branch}\`, ${pullRequest.state}`;
}

/**
 * `target` named the way the spec review body names anything outside
 * `supertaskRepo` itself: bare `#N` where `target` lives in `supertaskRepo`,
 * `owner/repo#N` — per `ticketReference` — otherwise, since a bare number
 * would resolve against `supertaskRepo`, the spec review's own repo, and
 * name the wrong issue or pull request there. The one rule `subIssueLine`
 * applies to both a sub-issue's own name and its matched pull request's.
 */
function referenceFrom(
  supertaskRepo: RepoSlug,
  target: Pick<Ticket, "repo" | "number">,
): string {
  return target.repo === supertaskRepo ? `#${target.number}` : ticketReference(target);
}
