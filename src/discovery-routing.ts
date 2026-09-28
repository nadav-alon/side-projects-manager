import type {
  Discovery,
  DiscoveryKind,
  IssueReference,
  IssueTracker,
  RepoSlug,
  Ticket,
} from "./ports/index.ts";
import {
  discoveredBody,
  isIssueNumber,
  isPullRequestTicket,
  isRepoSlug,
  isSpecReviewTicket,
  parentTicketIn,
  targetNoun,
  ticketReference,
} from "./ports/index.ts";
import { errorMessage } from "./error-message.ts";

/**
 * The one line a body names its blocker on, per `CONTEXT.md`'s "Discovery"
 * and the discovery instructions: `Blocked on: owner/repo#n`, or a bare `#n`
 * for the repo the text is posted in — the two shapes `ticketReference`
 * itself produces, so the two GitHub autolinks from any repo, behind the
 * literal marker `DISCOVERY_INSTRUCTIONS` (`container-sandbox.ts`) tells the
 * agent to write. Anchored to the start of a line — with `m` — rather than
 * matched anywhere in the body: prose naming an unrelated issue elsewhere
 * ("unlike #12, this needs...") is not a claim that this one waits on it, and
 * matching loosely there let one such mention silently pick the wrong
 * blocker. The owner and repo character classes are looser than
 * `isRepoSlug`'s own, which `referencedIssueIn` checks afterwards, so a match
 * here is a candidate, never a guarantee.
 */
const BLOCKED_ON_LINE =
  /^[ \t]*blocked on:?[ \t]+(?:([A-Za-z0-9][\w.-]*\/[A-Za-z0-9._-]+)#(\d+)|#(\d+))/im;

/**
 * The existing issue a prerequisite discovery's body names it waits on, per
 * `CONTEXT.md`'s "Discovery": the issue a `Blocked on:` line names, per
 * `BLOCKED_ON_LINE` — never one merely mentioned in passing elsewhere in the
 * body. A bare `#n` names an issue in `sameRepo` — the target the prerequisite
 * would otherwise block — the way GitHub itself resolves one to whichever
 * repo the text is posted in. `undefined` where `body` carries no such line,
 * or names a repo that is not shaped like one — a typo misread as a
 * nonexistent issue is safer than one silently redirected to `sameRepo`.
 */
export function referencedIssueIn(
  body: string,
  sameRepo: RepoSlug,
): IssueReference | undefined {
  const match = BLOCKED_ON_LINE.exec(body);
  if (match === null) {
    return undefined;
  }
  const [, repoText, crossNumber, bareNumber] = match;
  const numberText = crossNumber ?? bareNumber;
  if (numberText === undefined) {
    return undefined;
  }
  const number = Number(numberText);
  if (!isIssueNumber(number)) {
    return undefined;
  }
  if (repoText === undefined) {
    return { repo: sameRepo, number };
  }
  return isRepoSlug(repoText) ? { repo: repoText, number } : undefined;
}

/**
 * Whether `kind` is one of the two kinds that can stop the run's own ticket
 * from finishing normally, per CONTEXT.md's "Discovery": a correction (the
 * ticket is wrong) and a prerequisite (the work needs something nobody
 * ticketed); a clarification and a suggestion are advisory and never do.
 *
 * Necessary but not sufficient for a prerequisite: one naming an issue that
 * is already ticketed and still open blocks that issue directly instead —
 * `"blocked-on-existing"`, per `FiledDiscovery` — and the run it was filed
 * against goes on same as an advisory kind would. `isBlockingFiledDiscovery`
 * is what reads a filed discovery's actual outcome; this is what every other
 * caller — one deciding before anything is filed, such as
 * `routeDiscoveries`'s own refusal path, where there is no outcome yet to
 * read — still has.
 */
export function isBlockingDiscoveryKind(kind: DiscoveryKind): boolean {
  return kind === "correction" || kind === "prerequisite";
}

/**
 * One discovery once the loop decided what to do with it: a comment posted,
 * a native `blocked_by` edge added to an issue that was already ticketed —
 * `"blocked-on-existing"`, naming it as `blocker` — or a ticket opened, with
 * or without a blocking edge of its own.
 */
export type FiledDiscovery =
  | { discovery: Discovery; action: "commented" }
  | { discovery: Discovery; action: "blocked-on-existing"; blocker: IssueReference }
  | { discovery: Discovery; action: "discovered-ticket"; ticket: Ticket };

/**
 * Whether a filed discovery still blocks the run that filed it from
 * finishing normally, per CONTEXT.md's "Discovery": a correction always
 * does; a prerequisite does unless it named an already-ticketed, still-open
 * issue and blocked that one directly instead, in which case the run goes
 * on; a clarification or a suggestion never does.
 */
export function isBlockingFiledDiscovery(filed: FiledDiscovery): boolean {
  return isBlockingDiscoveryKind(filed.discovery.kind) && filed.action !== "blocked-on-existing";
}

/** A discovery the tracker refused to write: what was attempted, and why. */
export interface RefusedDiscovery {
  discovery: Discovery;
  reason: string;
}

/**
 * What became of a run's discoveries once the loop routed every one of them:
 * by kind, per CONTEXT.md's "Discovery" — a correction or a clarification is
 * a comment, a prerequisite is a discovered ticket that blocks the target
 * unless it named an existing, still-open issue, in which case it blocks
 * that one directly instead, a suggestion is a discovered ticket with no
 * edge. At most one suggestion is ever filed; the rest are counted in
 * `suggestionsDropped` rather than sent to the tracker at all — distinct
 * from a **dropped discovery** (`container-sandbox.ts`'s `readDiscoveries`),
 * which never became a `Discovery` in the first place. Clarifications carry
 * no such cap.
 *
 * A discovery the tracker refused to write is counted in `refused` rather
 * than `filed`, but a blocking-kind one still counts toward `blocking`, since
 * the refusal is the tracker's problem, not a reason to treat what the agent
 * found as though it never happened — there is no filed outcome to read for
 * one, so `isBlockingFiledDiscovery` never applies to it; kind alone
 * (`isBlockingDiscoveryKind`) decides instead, same as it would have had the
 * write succeeded and named no existing issue.
 */
export interface DiscoveryRouting {
  filed: FiledDiscovery[];
  suggestionsDropped: number;
  refused: RefusedDiscovery[];
  /**
   * The discoveries that still block the run's own ticket from finishing
   * normally, in the order the agent filed them: every correction, every
   * refused prerequisite, and every filed prerequisite except one that named
   * an existing, still-open issue and blocked that one directly instead. What
   * `hasBlockingDiscovery` and `blockingDiscoveriesOf` read, computed once
   * here — in the one loop (`routeDiscoveries`) that already knows each
   * discovery's own outcome the moment it is filed or refused — rather than
   * by every caller re-deriving it from `filed` and `refused` separately.
   */
  blocking: Discovery[];
  /**
   * How many files under the run's own `/discoveries` mount never became a
   * `Discovery` at all — CONTEXT.md's **Dropped discovery**: not valid JSON,
   * or naming a kind outside the four. Always present, 0 when the run left
   * none, so a reader never has to check for absence the way `filed` and
   * `refused` items themselves do.
   */
  discoveriesDropped: number;
}

/** Whether `routing` carries a discovery that still blocks the run's own ticket from finishing normally. */
export function hasBlockingDiscovery(routing: DiscoveryRouting): boolean {
  return routing.blocking.length > 0;
}

/** The discoveries in `routing` that still block the run's own ticket, in the order the agent filed them. */
export function blockingDiscoveriesOf(routing: DiscoveryRouting): Discovery[] {
  return routing.blocking;
}

/**
 * The sections an agent brief must name, per `CONTEXT.md`'s "Ready
 * discovery": current behavior, desired behavior, acceptance criteria and
 * out of scope — the same shape triage itself writes when it hands a ticket
 * to an agent. Matched loosely, by keyword rather than by heading syntax or
 * order, since the filer writes prose, not a form; "behaviour" is accepted
 * beside "behavior" for the same reason. Anchored to the start of a line,
 * with an optional markdown heading or bold marker before the phrase, so a
 * body that merely mentions all four phrases in passing — inside one
 * sentence, say — does not clear the gate a real brief's own section
 * openers do.
 */
const AGENT_BRIEF_SECTIONS = [
  /^\s*(?:#{1,6}\s*|\*{1,2}\s*)?current behaviou?r/im,
  /^\s*(?:#{1,6}\s*|\*{1,2}\s*)?desired behaviou?r/im,
  /^\s*(?:#{1,6}\s*|\*{1,2}\s*)?acceptance criteria/im,
  /^\s*(?:#{1,6}\s*|\*{1,2}\s*)?out of scope/im,
];

/**
 * Whether `body` reads as an agent brief: every section
 * `AGENT_BRIEF_SECTIONS` names is somewhere in the text. What a ready
 * discovery's body must be, per `CONTEXT.md`'s "Ready discovery" — a
 * discovery that declares itself ready but is not shaped like a brief falls
 * back to needs-triage all the same, per `fileDiscovery`.
 */
export function isAgentBrief(body: string): boolean {
  return AGENT_BRIEF_SECTIONS.every((section) => section.test(body));
}

/**
 * Whether a prerequisite or a suggestion declaring itself ready actually
 * opens ready, per `CONTEXT.md`'s "Ready discovery": `discovery.ready` is
 * only the filer's own claim, so this still checks the two things that are
 * not the filer's to decide. `body` must read as an agent brief
 * (`isAgentBrief`) — a bare `ready: true` on an ordinary-shaped body changes
 * nothing. And `target` — the ticket the discovery is filed against — must
 * not itself carry `readyDiscovery`: a ticket already born from a ready
 * discovery is one hop into a chain of unreviewed work, and a second hop
 * falls back to needs-triage rather than compounding it. `target` rather than
 * the run's own ticket, so a review, apply-review or rebase run — whose own
 * ticket never carries `readyDiscovery`, only the implementation ticket its
 * discoveries land on might — still closes the chain.
 */
function opensReady(target: Ticket, discovery: Discovery): boolean {
  return (
    discovery.ready === true &&
    isAgentBrief(discovery.body) &&
    target.readyDiscovery !== true
  );
}

/**
 * Whether `reference` names `target` itself — a prerequisite cannot block its
 * own target on itself, and `IssueTracker.blockOnIfOpen`'s own native
 * `blocked_by` edge would refuse a self-edge outright. Checked here rather
 * than left to that refusal, so a prerequisite that merely names its own
 * ticket in passing still falls back to `createDiscoveredTicket` instead of
 * being counted refused.
 */
function isSelfReference(target: Ticket, reference: IssueReference): boolean {
  return reference.repo === target.repo && reference.number === target.number;
}

/**
 * Files one discovery against `target`: a comment for a correction or a
 * clarification; for a prerequisite, a native `blocked_by` edge onto an
 * issue its own body names — where that issue is open right now — with a
 * comment naming it, or, failing that, a discovered ticket that blocks
 * `target` instead; for a suggestion, a discovered ticket with no edge —
 * opened ready per `opensReady` where either declares itself one. For a
 * comment, `runTicket` names what `discoveredBody` says this was discovered
 * while working, so a discovery landing on a different ticket than the one
 * that found it still reads in context; a discovered ticket's own body names
 * `target` that way instead — `createDiscoveredTicket`'s callers build it
 * from the ticket they were handed, per `discoveredBody`, so it reads as
 * discovered while working the ticket it blocks or rides alongside, not the
 * run that found it. `target` is also what `opensReady` reads for the chain
 * guard: whatever ticket the run itself was working, it is `target` that may
 * or may not have come from a ready discovery, and what `referencedIssueIn`
 * reads as the repo a bare `#n` names, per CONTEXT.md's "Discovery".
 */
async function fileDiscovery(
  tracker: Pick<IssueTracker, "comment" | "createDiscoveredTicket" | "blockOnIfOpen">,
  runTicket: Ticket,
  target: Ticket,
  discovery: Discovery,
): Promise<FiledDiscovery> {
  if (discovery.kind === "correction" || discovery.kind === "clarification") {
    await tracker.comment(
      target,
      `${discovery.title}\n\n${discoveredBody(runTicket, discovery.body)}`,
    );
    return { discovery, action: "commented" };
  }
  if (discovery.kind === "prerequisite") {
    const named = referencedIssueIn(discovery.body, target.repo);
    const blocker =
      named !== undefined && !isSelfReference(target, named) ? named : undefined;
    if (blocker !== undefined) {
      // A transient tracker failure here — or `blocker` naming a pull
      // request, or an edge that already exists — is not a reason to lose
      // the discovery: today's fallback, a discovered ticket, still applies,
      // per CONTEXT.md's "Discovery" ("keeps today's behavior").
      const blockedOnExisting = await tracker.blockOnIfOpen(target, blocker).catch(() => false);
      if (blockedOnExisting) {
        // Best effort: the edge is what actually blocks `target`, so a
        // comment that fails to post is not worth losing that over, or worth
        // this discovery being counted refused and blocking on its own
        // account when it already blocked another way.
        await tracker
          .comment(
            target,
            `${discovery.title}\n\n${discoveredBody(runTicket, discovery.body)}\n\n` +
              `Blocked on ${ticketReference(blocker)} until it closes.`,
          )
          .catch(() => undefined);
        return { discovery, action: "blocked-on-existing", blocker };
      }
    }
  }
  const ticket = await tracker.createDiscoveredTicket(target, {
    title: discovery.title,
    body: discovery.body,
    blocking: discovery.kind === "prerequisite",
    ready: opensReady(target, discovery),
  });
  return { discovery, action: "discovered-ticket", ticket };
}

/**
 * Routes every one of `discoveries` against `target`, per CONTEXT.md's
 * "Discovery": at most the first suggestion is filed, the rest dropped and
 * counted; every correction, prerequisite and clarification is filed. A
 * discovery the tracker refuses is reported in `refused` rather than stopping
 * the rest — one refusal never costs the ones behind it. `discoveriesDropped`
 * is passed straight through onto the answer, unread here: this function
 * never sees the raw files a run's `/discoveries` mount held, only the ones
 * that parsed.
 */
export async function routeDiscoveries(
  tracker: Pick<IssueTracker, "comment" | "createDiscoveredTicket" | "blockOnIfOpen">,
  runTicket: Ticket,
  target: Ticket,
  discoveries: readonly Discovery[],
  discoveriesDropped = 0,
): Promise<DiscoveryRouting> {
  const filed: FiledDiscovery[] = [];
  const refused: RefusedDiscovery[] = [];
  const blocking: Discovery[] = [];
  let suggestionFiled = false;
  let suggestionsDropped = 0;

  for (const discovery of discoveries) {
    if (discovery.kind === "suggestion" && suggestionFiled) {
      suggestionsDropped += 1;
      continue;
    }
    try {
      const outcome = await fileDiscovery(tracker, runTicket, target, discovery);
      filed.push(outcome);
      if (discovery.kind === "suggestion") {
        suggestionFiled = true;
      }
      if (isBlockingFiledDiscovery(outcome)) {
        blocking.push(discovery);
      }
    } catch (error: unknown) {
      refused.push({ discovery, reason: errorMessage(error) });
      if (isBlockingDiscoveryKind(discovery.kind)) {
        blocking.push(discovery);
      }
    }
  }

  return { filed, suggestionsDropped, refused, blocking, discoveriesDropped };
}

/**
 * The ticket a run's discoveries are about, per CONTEXT.md's "Discovery": an
 * implementation run's own ticket, or — for a review, apply-review or rebase
 * run — the implementation ticket its pull request ticket is a sub-issue of,
 * or — for a spec review run — the supertask it is a sub-issue of, read off
 * `IssueTracker.listOpenIssues` the way `selection.ts` and
 * `spec-review-sweep.ts` already read a sub-issue's parent.
 */
type DiscoveryTarget = { ticket: Ticket } | { error: string };

async function discoveryTargetFor(
  tracker: Pick<IssueTracker, "listOpenIssues">,
  ticket: Ticket,
): Promise<DiscoveryTarget> {
  if (!isPullRequestTicket(ticket) && !isSpecReviewTicket(ticket)) {
    return { ticket };
  }
  const open = await tracker.listOpenIssues(ticket.repo);
  const parent = parentTicketIn(open, ticket);
  if (parent !== undefined) {
    return { ticket: parent };
  }
  return {
    error: `could not find the ${targetNoun(ticket)} #${ticket.number} is a sub-issue of`,
  };
}

/**
 * `routeRunDiscoveries`'s answer: the target its discoveries were routed
 * against, and what became of every one of them.
 */
export interface RoutedDiscoveries {
  target: Ticket;
  /**
   * `target`, but present only when it differs from the ticket whose run
   * these discoveries are — a pull request ticket's run, whose discoveries
   * land on its implementation ticket instead of the ticket the run itself
   * worked, or a spec review run's, whose discoveries land on its supertask.
   * Absent for an implementation run, whose target is its own ticket.
   * Precomputed here, once, rather than by every reader comparing `target`
   * against the ticket it already has in hand.
   */
  crossTarget?: Ticket;
  routing: DiscoveryRouting;
}

/**
 * The routing and cross-target pair every iteration outcome that can carry
 * discoveries carries together, per CONTEXT.md's "Discovery" — a slice of
 * `RoutedDiscoveries`, leaving out its own `target`, which is
 * `routeRunDiscoveries`'s callers' to keep to themselves.
 */
export type DiscoveryReport = Pick<RoutedDiscoveries, "routing" | "crossTarget">;

/**
 * Resolves `ticket`'s discovery target and routes `discoveries` against it, in
 * one call — the one entry point `morning-run.ts` needs. Answers `undefined`
 * when there is nothing to route: `discoveries` is absent or empty and
 * `discoveriesDropped` is 0, which is the ordinary case for a run that filed
 * nothing and dropped nothing.
 *
 * A run that dropped files but filed no discovery never resolves a target at
 * all: there is nothing to file against one, so nothing here would ever read
 * it back, and resolving one anyway would cost a pull request ticket's run a
 * `listOpenIssues` call — the out-of-scope `morningRun` behaviour #598's
 * ticket bars — for no reason at all. `target` reads as `ticket` itself in
 * this case, same as every other run whose target never differs from the
 * ticket it worked.
 *
 * A target that cannot be resolved for a run that did file something — a pull
 * request ticket whose implementation ticket, or a spec review ticket whose
 * supertask, `listOpenIssues` does not report, most likely a truncated
 * backlog — refuses every discovery with that same reason, `ticket` itself
 * standing in for the target nothing could be filed against, rather than
 * losing what the agent found.
 */
export async function routeRunDiscoveries(
  tracker: Pick<
    IssueTracker,
    "listOpenIssues" | "comment" | "createDiscoveredTicket" | "blockOnIfOpen"
  >,
  ticket: Ticket,
  discoveries: readonly Discovery[] | undefined,
  discoveriesDropped = 0,
): Promise<RoutedDiscoveries | undefined> {
  const found = discoveries ?? [];
  if (found.length === 0 && discoveriesDropped === 0) {
    return undefined;
  }
  if (found.length === 0) {
    return {
      target: ticket,
      routing: { filed: [], suggestionsDropped: 0, refused: [], blocking: [], discoveriesDropped },
    };
  }
  const resolved = await discoveryTargetFor(tracker, ticket).catch(
    (error: unknown): DiscoveryTarget => ({ error: errorMessage(error) }),
  );
  if ("error" in resolved) {
    return {
      target: ticket,
      routing: {
        filed: [],
        suggestionsDropped: 0,
        refused: found.map((discovery) => ({
          discovery,
          reason: resolved.error,
        })),
        // Nothing was filed for any of them, so kind alone decides, the same
        // as a refusal inside `routeDiscoveries`'s own loop would.
        blocking: found.filter((discovery) => isBlockingDiscoveryKind(discovery.kind)),
        discoveriesDropped,
      },
    };
  }
  const crossTarget =
    resolved.ticket.number === ticket.number ? undefined : resolved.ticket;
  return {
    target: resolved.ticket,
    ...(crossTarget !== undefined && { crossTarget }),
    routing: await routeDiscoveries(tracker, ticket, resolved.ticket, found, discoveriesDropped),
  };
}
