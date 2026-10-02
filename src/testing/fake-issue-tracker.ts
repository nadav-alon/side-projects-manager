import type {
  ApplyReviewTicket,
  DiscoveredTicketRequest,
  DiscoveredTicketSummary,
  HandBackOutcome,
  IssueNumber,
  IssueReference,
  IssueTracker,
  IssueUrl,
  LabelAction,
  LabelTimelineEvent,
  OpenIssue,
  OpenIssues,
  PullRequestUrl,
  RebaseTicket,
  RepoSlug,
  ReviewTicket,
  GrantRecord,
  RunSpan,
  SubIssue,
  Ticket,
  TurboableConsent,
} from "../ports/index.ts";
import {
  READY_FOR_AGENT_LABEL,
  READY_FOR_HUMAN_LABEL,
  SPEC_REVIEW_LABEL,
  UX_REVIEW_LABEL,
  SPEC_REVIEW_SIZE_LABEL,
  SUPERTASK_LABEL,
  TURBOABLE_LABEL,
  carriesReadyDiscoveryLabel,
  carriesReadyForAgent,
  carriesSpecReviewLabel,
  carriesUxReviewLabel,
  carriesSupertaskLabel,
  discoveredBody,
  discoveredTicketLabels,
  issueNumber,
  issueUrl,
  modelLabelOf,
  reviewTitle,
  sizeLabelOf,
  specReviewTitle,
  ticketReference,
  turboableConsentAt,
} from "../ports/index.ts";
import type { SummaryTracker } from "../summary.ts";

/** One summary issue the fake was asked to publish, in the order asked. */
export interface FakeSummary {
  title: string;
  body: string;
  url: IssueUrl;
}

/** One review ticket the loop opened, in the order the fake received it. */
export interface FakeReviewTicket {
  /** The implementation ticket the review is a sub-issue of. */
  parent: Ticket;
  /** The draft pull request the review is for. */
  pullRequest: PullRequestUrl;
  /** The review ticket itself, as the fake numbered it. */
  ticket: Ticket;
}

/** One spec review ticket the sweep opened, in the order the fake received it. */
export interface FakeSpecReviewTicket {
  /** The supertask the spec review reviews. */
  parent: Ticket;
  /** The body the caller composed for it. */
  body: string;
  /** The spec review ticket itself, as the fake numbered it. */
  ticket: Ticket;
}

/** One ticket given back to the developer, and what it was told. */
export interface FakeHandback {
  ticket: Ticket;
  comment: string;
}

/** One plain comment the fake was given, in the order it was posted. */
export interface FakeComment {
  ticket: Ticket;
  comment: string;
}

/**
 * One discovered ticket the loop opened, in the order it was opened. Not a
 * sub-issue of `discoveredWhile` — a discovered ticket never is, per #595 —
 * so it does not share `FakeReviewTicket`'s `parent` field name, which does
 * carry that meaning.
 */
export interface FakeDiscoveredTicket {
  /** The ticket it was discovered while working. */
  discoveredWhile: Ticket;
  title: string;
  /** `discoveredBody(discoveredWhile, …)`: the given body, naming it. */
  body: string;
  /**
   * Whether a `blocked_by` edge from `discoveredWhile` to `ticket` was
   * added — not merely asked for: `false` where `discoveredWhile` was never
   * put in the fake, the one way this can diverge from `discovery.blocking`.
   */
  blocking: boolean;
  /** The discovered ticket itself, as the fake numbered it. */
  ticket: Ticket;
}

/**
 * An open issue as the fake holds it: its ticket facts and its links, flat,
 * without what the fake works out on each listing — no `eligible`,
 * `modelLabel`, `sizeLabel`, `supertask`, `specReview`, `uxReview` or
 * `readyDiscovery`, which come from the labels it carries — and `openBlockerNumbers` optional,
 * since most tests give none.
 */
type StoredIssue = Omit<
  Ticket,
  | "modelLabel"
  | "sizeLabel"
  | "supertask"
  | "specReview"
  | "uxReview"
  | "readyDiscovery"
> &
  Partial<Pick<OpenIssue, "parent" | "openBlockerNumbers">>;

/**
 * A ticket as a test hands it to the fake. No `modelLabel`, `sizeLabel`,
 * `supertask`, `specReview`, `uxReview` or `readyDiscovery`, not even on a
 * wider `Ticket`: the fake reads all six from the labels a ticket holds, the way
 * the real tracker does.
 */
type TicketInput = Omit<StoredIssue, "repo"> & {
  modelLabel?: never;
  sizeLabel?: never;
  supertask?: never;
  specReview?: never;
  uxReview?: never;
  readyDiscovery?: never;
};

/** One entry the fake holds: the open issue, and the labels it carries. */
interface Stored {
  issue: StoredIssue;
  labels: Set<string>;
  /**
   * Set once one of the close calls has closed this issue. Kept, rather than
   * dropped from `#issues` outright, so a closed ticket's labels stay
   * inspectable through `carriesLabel` — a real close leaves the label state
   * behind for a reopen or a label query to find, and a fake that discarded
   * the entry could never get that wrong.
   */
  closed?: boolean;
}

/**
 * An in-memory set of open issues per project, modelling the real tracker's
 * own notion of eligibility: every open issue is listed, and an issue is
 * eligible only while it carries `READY_FOR_AGENT_LABEL`.
 *
 * Tests that care which repos were asked about spy on `listOpenIssues`
 * with `t.mock.method`; the fake does not record calls itself.
 */
export class FakeIssueTracker implements IssueTracker, SummaryTracker {
  readonly #issues = new Map<RepoSlug, Stored[]>();
  readonly #truncated = new Set<RepoSlug>();
  /**
   * The prerequisites `blockOnIfOpen` was asked to block a ticket on and
   * found open, by the blocked ticket's own key — never `discovery.blocking`'s
   * own edge, which `createDiscoveredTicket` tracks through `openBlockerNumbers`
   * on the stored issue itself. Kept apart because a prerequisite may name an
   * issue in another repo, which `openBlockerNumbers` — same-repo only, per
   * `OpenIssue`'s own doc — cannot hold; `listOpenIssues` folds both into the
   * `Ticket` it reports.
   */
  readonly #namedPrerequisites = new Map<string, IssueReference[]>();
  /**
   * Sub-issue links `listSubIssues` reports outside the `parent` field on
   * `TicketInput`: a cross-repo sub-issue, keyed by its parent's `ticketReference`.
   * `parent` alone cannot model one — `OpenIssue.parent`'s own contract keeps
   * it same-repo-only, and `parent` feeds that field too — so `linkSubIssue`
   * is the only way to add one.
   */
  readonly #subIssueLinks = new Map<string, Ticket[]>();

  /** The review tickets opened, in the order they were opened. */
  readonly reviewTickets: FakeReviewTicket[] = [];
  /** The spec review tickets opened, in the order they were opened. */
  readonly specReviewTickets: FakeSpecReviewTicket[] = [];
  /** The spec review tickets linked to a supertask without being opened, in link order — see {@link linkSpecReviewTicket}. */
  readonly linkedSpecReviewTickets: FakeSpecReviewTicket[] = [];
  /** Tickets handed back, in the order they were handed back. */
  readonly handbacks: FakeHandback[] = [];

  /** Plain comments posted, in the order they were posted. */
  readonly comments: FakeComment[] = [];

  /** Discovered tickets opened, in the order they were opened. */
  readonly discoveredTickets: FakeDiscoveredTicket[] = [];

  /** The review tickets closed, in the order they were closed. */
  readonly closedReviewTickets: ReviewTicket[] = [];

  /**
   * The comment a closed review ticket carried, in close order — only a
   * review closed for a pull request already merged or closed carries one.
   */
  readonly closedReviewTicketComments: { ticket: ReviewTicket; comment: string }[] =
    [];

  /** The apply-review tickets closed, in the order closed, with what each was told. */
  readonly closedApplyReviewTickets: {
    ticket: ApplyReviewTicket;
    comment: string;
  }[] = [];

  /** The rebase tickets closed, in the order closed, with what each was told. */
  readonly closedRebaseTickets: {
    ticket: RebaseTicket;
    comment: string;
  }[] = [];

  /** The summary issues published, in the order they were published. */
  readonly summaries: FakeSummary[] = [];

  /** Records the summary, and answers with a fresh issue address. Never fails — the fake has no repo to refuse it. */
  async publishSummary(title: string, body: string): Promise<IssueUrl> {
    const url = issueUrl(
      `https://github.com/nadav-alon/side-projects-manager/issues/${this.summaries.length + 1}`,
    );
    this.summaries.push({ title, body, url });
    return url;
  }

  /** Puts a ticket carrying `READY_FOR_AGENT_LABEL` in `repo`'s backlog and returns it. */
  addEligibleTicket(repo: RepoSlug, ticket: TicketInput): Ticket {
    return this.#add(repo, ticket, READY_FOR_AGENT_LABEL);
  }

  /**
   * Puts a ticket carrying `READY_FOR_HUMAN_LABEL` — never `READY_FOR_AGENT_LABEL`
   * — among `repo`'s open issues and returns it: a ticket the developer has not
   * triaged onto the loop, or has already handed back. Exists so a test can
   * prove such a ticket is never selected, even as its project's only ticket.
   */
  addIneligibleTicket(repo: RepoSlug, ticket: TicketInput): Ticket {
    return this.#add(repo, ticket, READY_FOR_HUMAN_LABEL);
  }

  /**
   * Puts a supertask — carrying `READY_FOR_AGENT_LABEL` and the supertask
   * label — in `repo`'s backlog and returns it. Exists so a test can prove
   * such a ticket is passed over even though it still carries
   * `READY_FOR_AGENT_LABEL`, at the loop's own seam rather than against a
   * query string.
   */
  addSupertask(repo: RepoSlug, ticket: TicketInput): Ticket {
    const supertask = this.#add(repo, ticket, READY_FOR_AGENT_LABEL);
    this.addLabel(supertask, SUPERTASK_LABEL);
    return supertask;
  }

  /**
   * Puts a ux review ticket — carrying `READY_FOR_AGENT_LABEL` and the ux-review
   * label — in `repo`'s backlog and returns it.
   */
  addUxReviewTicket(repo: RepoSlug, ticket: TicketInput): Ticket {
    const uxReview = this.#add(repo, ticket, READY_FOR_AGENT_LABEL);
    this.addLabel(uxReview, UX_REVIEW_LABEL);
    return uxReview;
  }

  /**
   * Puts a spec review ticket — carrying `READY_FOR_AGENT_LABEL` and the spec
   * review label — in `repo`'s backlog and returns it, the way a developer
   * opening one by hand would label it.
   */
  addSpecReviewTicket(repo: RepoSlug, ticket: TicketInput): Ticket {
    const specReview = this.#add(repo, ticket, READY_FOR_AGENT_LABEL);
    this.addLabel(specReview, SPEC_REVIEW_LABEL);
    return specReview;
  }

  /**
   * Puts a blocked ticket — carrying `READY_FOR_AGENT_LABEL` with
   * `openBlockers` open tickets blocking it — in `repo`'s backlog and returns
   * it. Exists so a test can prove such a ticket is passed over even though it
   * still carries the label.
   */
  addBlockedTicket(
    repo: RepoSlug,
    ticket: Omit<TicketInput, "openBlockers">,
    openBlockers: number,
  ): Ticket {
    return this.#add(repo, { ...ticket, openBlockers }, READY_FOR_AGENT_LABEL);
  }

  /**
   * Links `child` — already added, in whichever repo it lives — as a
   * sub-issue of `parent` for `listSubIssues` to report, the way a real
   * cross-repo sub-issue relation is visible there but never through
   * `listOpenIssues`'s own `parent` field. A same-repo sub-issue is linked by
   * passing `parent` to `addEligibleTicket` instead; this exists for the case
   * `parent` cannot model.
   */
  linkSubIssue(parent: Ticket, child: Ticket): void {
    const key = ticketReference(parent);
    const links = this.#subIssueLinks.get(key) ?? [];
    links.push(child);
    this.#subIssueLinks.set(key, links);
  }

  /**
   * Puts `label` on `ticket`, the way the developer labels a ticket by hand —
   * a model label, say. Read on the next `listOpenIssues`, not before.
   */
  addLabel(ticket: IssueReference, label: string): void {
    this.#find(ticket)?.labels.add(label);
  }

  /** Takes `label` off `ticket`, the way the developer unlabels one by hand. */
  removeLabel(ticket: IssueReference, label: string): void {
    this.#find(ticket)?.labels.delete(label);
  }

  /**
   * Closes `ticket` out of band — the way an overlapping run's own success,
   * or a human on the tracker's own UI, might — without going through any of
   * the loop's own close methods. Exists so a test can arrange the race
   * `handBack` must leave alone: a ticket already closed by the time the loop
   * gets back to it.
   */
  closeOutOfBand(ticket: Ticket): void {
    this.#close(ticket);
  }

  /**
   * Whether `ticket` currently carries `label`, closed or not — the way a
   * label query against the real tracker would find it, even once
   * `listOpenIssues` has stopped listing the ticket at all.
   */
  carriesLabel(ticket: IssueReference, label: string): boolean {
    return this.#find(ticket)?.labels.has(label) ?? false;
  }

  #find(ticket: IssueReference): Stored | undefined {
    return (this.#issues.get(ticket.repo) ?? []).find(
      (candidate) => candidate.issue.number === ticket.number,
    );
  }

  /**
   * Whether `reference` is open right now, given `ifMissing` for a reference
   * not found at all — the one thing `#stillOpen` and `blockOnIfOpen` disagree
   * on, so each names its own answer explicitly rather than share a fixed
   * convention a reader would have to look up.
   */
  #isOpen(reference: IssueReference, ifMissing: boolean): boolean {
    const found = this.#find(reference);
    return found === undefined ? ifMissing : found.closed !== true;
  }

  /**
   * Whether `reference` is open right now: not found at all counts as open,
   * the same convention `listOpenIssues` already applies to a same-repo
   * blocker `addBlockedTicket` names without a stored entry to check — a
   * number this fake never saw is not something it can call closed.
   * `blockOnIfOpen` itself never stores a reference it did not first confirm
   * this way, so in practice a reference read back here is always found.
   */
  #stillOpen(reference: IssueReference): boolean {
    return this.#isOpen(reference, true);
  }

  #add(repo: RepoSlug, ticket: TicketInput, label: string): Ticket {
    const stored: StoredIssue = { repo, ...ticket };
    const issues = this.#issues.get(repo) ?? [];
    issues.push({ issue: stored, labels: new Set([label]) });
    this.#issues.set(repo, issues);
    return stored;
  }

  /**
   * A number above every ticket `repo` has — eligible or not, the way the
   * real tracker never reuses a number — for `createReviewTicket` and
   * `createDiscoveredTicket` to number what they open above `ticket` too, in
   * case `repo` was seeded with a smaller newest number than `ticket`'s own.
   */
  #nextNumber(repo: RepoSlug, ticket: Ticket): IssueNumber {
    const numbers = (this.#issues.get(repo) ?? []).map(
      (entry) => entry.issue.number,
    );
    return issueNumber(Math.max(ticket.number, ...numbers) + 1);
  }

  /**
   * Marks `repo`'s backlog as a truncated backlog: more open issues than the
   * loop reads in one morning. The issues listed stay exactly those added, so
   * a test arranges the ones read and says there were more.
   */
  truncateBacklog(repo: RepoSlug): void {
    this.#truncated.add(repo);
  }

  /**
   * `entry` as a `Ticket`: its eligibility-independent facts, plus the model
   * label, size label, supertask status, spec review status and ready
   * discovery status the real tracker reads from the labels it holds at the
   * time of the call — so a label changed between calls changes what the
   * next call returns. Shared by `listOpenIssues` and `listSubIssues`, the
   * fake's two readers of a stored issue as a ticket.
   */
  #ticketOf(entry: Stored): Ticket {
    const { parent: _parent, openBlockerNumbers: _openBlockerNumbers, ...ticket } =
      entry.issue;
    const modelLabel = modelLabelOf(entry.labels);
    const sizeLabel = sizeLabelOf(entry.labels);
    const supertask = carriesSupertaskLabel(entry.labels);
    const specReview = carriesSpecReviewLabel(entry.labels);
    const uxReview = carriesUxReviewLabel(entry.labels);
    const readyDiscovery = carriesReadyDiscoveryLabel(entry.labels);
    return {
      ...ticket,
      ...(modelLabel !== undefined && { modelLabel }),
      ...(sizeLabel !== undefined && { sizeLabel }),
      ...(supertask && { supertask }),
      ...(specReview && { specReview }),
      ...(uxReview && { uxReview }),
      ...(readyDiscovery && { readyDiscovery }),
    };
  }

  /**
   * An issue's eligibility, model label, size label and supertask status are
   * read from the labels it holds at the time of the call, through the same
   * `modelLabelOf`, `sizeLabelOf` and `carriesSupertaskLabel` the real tracker
   * uses, so a label changed between calls changes what the next call
   * returns. Issues are listed in the order they were added.
   */
  async listOpenIssues(repo: RepoSlug): Promise<OpenIssues> {
    const stored = this.#issues.get(repo) ?? [];
    const open = stored.filter((entry) => !entry.closed);
    const issues = open.map((entry) => {
      const {
        parent,
        openBlockerNumbers: numbers = [],
        openBlockers: staticBlockers,
      } = entry.issue;
      // As the real tracker recomputes `openBlockers` from each blocker's
      // state on every listing (`gh-issue-tracker.ts`'s `stillBlocking`):
      // a number tracked here stays counted only while its own entry is
      // still open. `staticBlockers` — set by `addBlockedTicket`, which
      // tracks no numbers of its own — is added rather than replaced, so
      // that helper's count is untouched by this.
      const openBlockerNumbers = numbers.filter((number) => {
        const blocker = stored.find(
          (candidate) => candidate.issue.number === number,
        );
        return blocker === undefined || blocker.closed !== true;
      });
      // `blockOnIfOpen`'s own edges, recomputed the same live way: a
      // same-repo one joins `openBlockerNumbers`, per `OpenIssue`'s own doc
      // on it being same-repo only; a cross-repo one — the whole reason a
      // prerequisite may name another project's issue — only ever reaches
      // `openBlockers`.
      const named = this.#namedPrerequisites.get(ticketReference({ repo, number: entry.issue.number })) ?? [];
      const openNamedSameRepo = named
        .filter((reference) => reference.repo === repo)
        .map((reference) => reference.number)
        .filter((number) => this.#stillOpen({ repo, number }));
      const openNamedCrossRepo = named.filter(
        (reference) => reference.repo !== repo && this.#stillOpen(reference),
      ).length;
      const allOpenBlockerNumbers = [...openBlockerNumbers, ...openNamedSameRepo];
      const openBlockers =
        (staticBlockers ?? 0) + allOpenBlockerNumbers.length + openNamedCrossRepo;
      return {
        ticket: {
          ...this.#ticketOf(entry),
          ...(openBlockers > 0 && { openBlockers }),
        },
        eligible: carriesReadyForAgent(entry.labels),
        openBlockerNumbers: allOpenBlockerNumbers,
        ...(parent !== undefined && { parent }),
      };
    });
    return {
      issues,
      truncated: this.#truncated.has(repo),
    };
  }

  /**
   * Every entry stored against `ticket`'s repo whose `parent` names it, plus
   * every one `linkSubIssue` linked to it in another repo — open or closed
   * alike, unlike `listOpenIssues`, which drops a closed one outright. Listed
   * in the order each was added or linked, same-repo first.
   */
  async listSubIssues(ticket: Ticket): Promise<SubIssue[]> {
    const entries = this.#issues.get(ticket.repo) ?? [];
    const sameRepo = entries
      .filter((entry) => entry.issue.parent === ticket.number)
      .map((entry) => ({
        ticket: this.#ticketOf(entry),
        closed: entry.closed === true,
      }));
    const linked = (this.#subIssueLinks.get(ticketReference(ticket)) ?? []).map(
      (child) => {
        const entry = this.#find(child);
        return {
          ticket: entry === undefined ? child : this.#ticketOf(entry),
          closed: entry?.closed === true,
        };
      },
    );
    return [...sameRepo, ...linked];
  }

  /**
   * The open issues `createDiscoveredTicket` opened against `ticket`, as
   * the real tracker finds them by their body line: still-open ones only,
   * newest first, in `ticket`'s own repo.
   */
  async listOpenDiscoveredTickets(ticket: Ticket): Promise<DiscoveredTicketSummary[]> {
    return this.discoveredTickets
      .filter(
        ({ discoveredWhile, ticket: opened }) =>
          discoveredWhile.repo === ticket.repo &&
          discoveredWhile.number === ticket.number &&
          this.#find(opened)?.closed !== true,
      )
      .map(({ ticket: opened }) => ({ number: opened.number, title: opened.title }))
      .reverse();
  }

  readonly #turboableEvents = new Map<string, LabelTimelineEvent[]>();

  /**
   * Records a labeled or unlabeled event for `TURBOABLE_LABEL` against
   * `ticket` at `at`, the way a human's own label change on the tracker's UI
   * would be timestamped — what `wasTurboableAt` replays. Independent of
   * `addLabel`/`removeLabel`, which only ever change a ticket's current
   * labels: a test asserting what was true at a past instant needs the event
   * itself, timestamped, not just where the label stands today.
   */
  recordTurboableEvent(
    ticket: Ticket,
    action: LabelAction,
    at: Date,
  ): void {
    const key = ticketReference(ticket);
    const events = this.#turboableEvents.get(key) ?? [];
    events.push({ label: TURBOABLE_LABEL, action, at });
    this.#turboableEvents.set(key, events);
  }

  /** Replays the events `recordTurboableEvent` was given for `ticket`, same as the real tracker's own timeline read. */
  async wasTurboableAt(
    ticket: Ticket,
    instant: Date,
    spans: readonly RunSpan[],
    grants: readonly GrantRecord[],
  ): Promise<TurboableConsent> {
    return turboableConsentAt(
      ticket,
      this.#turboableEvents.get(ticketReference(ticket)) ?? [],
      instant,
      spans,
      grants,
    );
  }

  /**
   * The review lands in the same backlog its parent came from, because a real
   * review ticket is born ready-for-agent and is eligible from that moment.
   * Linked to it as a sub-issue, the way `createSpecReviewTicket` links a
   * spec review to its supertask — the real tracker's own `createReviewTicket`
   * hangs the review off `ticket` through `linkToParent`, so `listOpenIssues`
   * reports it back the same way here.
   *
   * Numbered above every ticket the repo has — eligible or not, the way the
   * real tracker never reuses a number — so a test can tell the review from
   * the ticket that earned it.
   */
  async createReviewTicket(
    ticket: Ticket,
    pullRequest: PullRequestUrl,
  ): Promise<Ticket> {
    const review = this.addEligibleTicket(ticket.repo, {
      number: this.#nextNumber(ticket.repo, ticket),
      title: reviewTitle(ticket),
      pullRequest: { kind: "review", url: pullRequest },
      parent: ticket.number,
    });

    this.reviewTickets.push({ parent: ticket, pullRequest, ticket: review });
    return review;
  }

  /**
   * The spec review lands in the same backlog its supertask came from, born
   * eligible and linked to it as a sub-issue — the way `createReviewTicket`
   * links a review to the ticket that earned it — and carrying the spec
   * review label and `SPEC_REVIEW_SIZE_LABEL`, the way the real tracker's own
   * `createSpecReviewTicket` labels it.
   *
   * Numbered above every ticket the repo has, as `createReviewTicket` numbers
   * a review, so a test can tell the spec review from the supertask that
   * earned it. Answers with `specReview: true` set directly, the same as the
   * real tracker's own return — unlike every other label-derived fact, which
   * the fake reads back only from a later `listOpenIssues` or `listSubIssues`
   * call, `isSpecReviewTicket` must already read `true` from the ticket
   * `createSpecReviewTicket` itself hands back, since nothing else names the
   * kind of ticket a caller just opened.
   */
  async createSpecReviewTicket(ticket: Ticket, body: string): Promise<Ticket> {
    const issues = this.#issues.get(ticket.repo) ?? [];
    const numbers = issues.map((entry) => entry.issue.number);
    const specReview = this.addEligibleTicket(ticket.repo, {
      number: issueNumber(Math.max(ticket.number, ...numbers) + 1),
      title: specReviewTitle(ticket),
      parent: ticket.number,
    });
    this.addLabel(specReview, SPEC_REVIEW_LABEL);
    this.addLabel(specReview, SPEC_REVIEW_SIZE_LABEL);

    const opened: Ticket = { ...specReview, specReview: true };
    this.specReviewTickets.push({ parent: ticket, body, ticket: opened });
    return opened;
  }

  /**
   * Links `specReview` — a spec review ticket already in the backlog,
   * carrying the spec review label but no `parent` of its own, the way
   * `addSpecReviewTicket` leaves one — as `supertask`'s sub-issue, the same
   * relation `createSpecReviewTicket` gives the one it creates. Recorded in
   * `linkedSpecReviewTickets` rather than `specReviewTickets`: nothing was
   * opened, only linked.
   *
   * Throws where `specReview` names no ticket this fake holds, the same as
   * the real tracker fails in `issueIdOf`, long before the POST: a test
   * handing this a `Ticket` the backlog never saw should not pass as if the
   * link succeeded.
   *
   * `body` is lazy on the real port, only ever called where the tracker has
   * no native sub-issue relation; the fake has no such distinction, so it
   * calls `body` every time, keeping `linkedSpecReviewTickets` inspectable
   * the same way regardless.
   */
  async linkSpecReviewTicket(
    specReview: Ticket,
    supertask: Ticket,
    body: () => Promise<string>,
  ): Promise<void> {
    const entry = this.#find(specReview);
    if (entry === undefined) {
      throw new Error(`#${specReview.number} in ${specReview.repo} is not a known ticket`);
    }
    entry.issue.parent = supertask.number;
    this.linkedSpecReviewTickets.push({
      parent: supertask,
      body: await body(),
      ticket: { ...specReview, specReview: true },
    });
  }

  async handBack(ticket: Ticket, comment: string): Promise<HandBackOutcome> {
    const entry = this.#find(ticket);
    // As the real tracker: a ticket an overlapping run already closed is left
    // exactly as it is — no comment recorded, no label touched.
    if (entry?.closed === true) {
      return "already-closed";
    }

    this.handbacks.push({ ticket, comment });
    // Loses ready-for-agent and gains ready-for-human, exactly the relabel the
    // real tracker makes — not removed from the open issues, since the ticket is
    // still there for the developer to find. Tests assert no retry by
    // invoking the loop again and finding nothing to select.
    entry?.labels.delete(READY_FOR_AGENT_LABEL);
    entry?.labels.add(READY_FOR_HUMAN_LABEL);
    return "handed-back";
  }

  /** Records the comment. Touches no label, the way the real tracker's plain comment does. */
  async comment(ticket: Ticket, comment: string): Promise<void> {
    this.comments.push({ ticket, comment });
  }

  /** Puts `TURBOABLE_LABEL` on `ticket`, as the real tracker does once it has made sure the label exists. */
  async labelTurboable(ticket: IssueReference): Promise<void> {
    this.addLabel(ticket, TURBOABLE_LABEL);
  }

  /**
   * Opens a discovered ticket, carrying `discoveredTicketLabels(ready)` — the
   * same set the real tracker's own `createDiscoveredTicket` builds a ticket
   * from. Numbered above every ticket the repo has, the way `createReviewTicket`
   * numbers a review. Asking for `discovery.blocking` adds `ticket`'s number
   * to its own open blockers, the same fact `openBlockers` reports from on
   * the next `listOpenIssues`.
   */
  async createDiscoveredTicket(
    ticket: Ticket,
    discovery: DiscoveredTicketRequest,
  ): Promise<Ticket> {
    const ready = discovery.ready === true;
    const [firstLabel, ...restLabels] = discoveredTicketLabels(ready);
    const discovered = this.#add(
      ticket.repo,
      {
        number: this.#nextNumber(ticket.repo, ticket),
        title: discovery.title,
      },
      firstLabel,
    );
    for (const label of restLabels) {
      this.addLabel(discovered, label);
    }

    // `blocked` — what actually happened — rather than `discovery.blocking`
    // — what was asked for: a ticket built by hand rather than through
    // `addEligibleTicket` has no entry to add the edge to, and recording
    // blocking regardless would claim an edge that changed nothing a
    // `listOpenIssues` could ever show.
    let blocked = false;
    if (discovery.blocking === true) {
      const parent = this.#find(ticket);
      if (parent !== undefined) {
        parent.issue.openBlockerNumbers = [
          ...(parent.issue.openBlockerNumbers ?? []),
          discovered.number,
        ];
        blocked = true;
      }
    }

    const opened: Ticket = { ...discovered, ...(ready && { readyDiscovery: true }) };
    this.discoveredTickets.push({
      discoveredWhile: ticket,
      title: discovery.title,
      body: discoveredBody(ticket, discovery.body),
      blocking: blocked,
      ticket: opened,
    });
    return opened;
  }

  /**
   * Records `prerequisite` against `ticket` and answers `true` when it is
   * open right now — a `prerequisite` this fake never held at all is not
   * open, the real tracker's own not-found answer per `blockOnIfOpen`'s own
   * doc on the port, so a test naming a nonexistent number sees the same
   * fallback.
   */
  async blockOnIfOpen(ticket: Ticket, prerequisite: IssueReference): Promise<boolean> {
    if (!this.#isOpen(prerequisite, false)) {
      return false;
    }
    const key = ticketReference(ticket);
    const named = this.#namedPrerequisites.get(key) ?? [];
    this.#namedPrerequisites.set(key, [...named, prerequisite]);
    return true;
  }

  /**
   * Closes `ticket`, the way a real close drops it from the open issues — a
   * ticket a later iteration must not see again — and takes ready-for-agent
   * off it, the way the real tracker's own close does. The entry itself
   * stays, marked closed, rather than being discarded: `carriesLabel` can
   * still find it, the way a label query against the real tracker would
   * find a closed issue's labels.
   */
  async closeReviewTicket(
    ticket: ReviewTicket,
    comment?: string,
  ): Promise<void> {
    this.closedReviewTickets.push(ticket);
    if (comment !== undefined) {
      this.closedReviewTicketComments.push({ ticket, comment });
    }
    this.#close(ticket);
    this.#find(ticket)?.labels.delete(READY_FOR_AGENT_LABEL);
  }

  /** As `closeReviewTicket`, keeping the comment it closed with. */
  async closeApplyReviewTicket(
    ticket: ApplyReviewTicket,
    comment: string,
  ): Promise<void> {
    this.closedApplyReviewTickets.push({ ticket, comment });
    this.#close(ticket);
  }

  /** As `closeReviewTicket`, keeping the comment it closed with. */
  async closeRebaseTicket(
    ticket: RebaseTicket,
    comment: string,
  ): Promise<void> {
    this.closedRebaseTickets.push({ ticket, comment });
    this.#close(ticket);
  }

  #close(ticket: Ticket): void {
    const entry = this.#find(ticket);
    if (entry !== undefined) {
      entry.closed = true;
    }
  }
}
