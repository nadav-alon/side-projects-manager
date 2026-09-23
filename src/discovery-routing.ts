import type {
  Discovery,
  DiscoveryKind,
  IssueTracker,
  Ticket,
} from "./ports/index.ts";
import {
  discoveredBody,
  isPullRequestTicket,
  isSpecReviewTicket,
  targetNoun,
} from "./ports/index.ts";
import { errorMessage } from "./error-message.ts";

/**
 * Whether `kind` stops the run's own ticket from finishing normally, per
 * CONTEXT.md's "Discovery": a correction (the ticket is wrong) and a
 * prerequisite (the work needs something nobody ticketed) are blocking; a
 * clarification and a suggestion are advisory.
 */
export function isBlockingDiscoveryKind(kind: DiscoveryKind): boolean {
  return kind === "correction" || kind === "prerequisite";
}

/** One discovery once the loop decided what to do with it: a comment posted, or a ticket opened, with or without a blocking edge. */
export type FiledDiscovery =
  | { discovery: Discovery; action: "commented" }
  | { discovery: Discovery; action: "discovered-ticket"; ticket: Ticket };

/** A discovery the tracker refused to write: what was attempted, and why. */
export interface RefusedDiscovery {
  discovery: Discovery;
  reason: string;
}

/**
 * What became of a run's discoveries once the loop routed every one of them:
 * by kind, per CONTEXT.md's "Discovery" — a correction or a clarification is
 * a comment, a prerequisite is a discovered ticket that blocks the target, a
 * suggestion is a discovered ticket with no edge. At most one suggestion is
 * ever filed; the rest are counted in `suggestionsDropped` rather than sent
 * to the tracker at all — distinct from a **dropped discovery**
 * (`container-sandbox.ts`'s `readDiscoveries`), which never became a
 * `Discovery` in the first place. Clarifications carry no such cap.
 *
 * A discovery the tracker refused to write is counted in `refused` rather
 * than `filed`, but still counts toward whether the run's ticket carries a
 * blocking discovery, since the refusal is the tracker's problem, not a
 * reason to treat what the agent found as though it never happened —
 * see `hasBlockingDiscovery`, which reads the run's own discoveries rather
 * than this split, so it need not care which side of it a discovery landed
 * on.
 */
export interface DiscoveryRouting {
  filed: FiledDiscovery[];
  suggestionsDropped: number;
  refused: RefusedDiscovery[];
  /**
   * How many files under the run's own `/discoveries` mount never became a
   * `Discovery` at all — CONTEXT.md's **Dropped discovery**: not valid JSON,
   * or naming a kind outside the four. Always present, 0 when the run left
   * none, so a reader never has to check for absence the way `filed` and
   * `refused` items themselves do.
   */
  discoveriesDropped: number;
}

/**
 * Whether `discoveries` names a correction or a prerequisite — either blocks
 * the run's own ticket from finishing normally. Takes the run's own
 * discoveries rather than a `DiscoveryRouting`: neither blocking kind is ever
 * dropped by the suggestion cap, so every one reaches `filed` or `refused`
 * regardless, and reading `discoveries` directly keeps the agent's own order
 * rather than the filed-then-refused order `DiscoveryRouting` splits them
 * into.
 */
export function hasBlockingDiscovery(discoveries: readonly Discovery[]): boolean {
  return discoveries.some((discovery) => isBlockingDiscoveryKind(discovery.kind));
}

/** The correction and prerequisite discoveries among `discoveries`, in the order the agent filed them. */
export function blockingDiscoveriesOf(discoveries: readonly Discovery[]): Discovery[] {
  return discoveries.filter((discovery) => isBlockingDiscoveryKind(discovery.kind));
}

/**
 * The sections an agent brief must name, per `CONTEXT.md`'s "Ready
 * discovery": current behavior, desired behavior, acceptance criteria and
 * out of scope — the same shape triage itself writes when it hands a ticket
 * to an agent. Matched loosely, by keyword rather than by heading syntax or
 * order, since the filer writes prose, not a form; "behaviour" is accepted
 * beside "behavior" for the same reason.
 */
const AGENT_BRIEF_SECTIONS = [
  /current behaviou?r/i,
  /desired behaviou?r/i,
  /acceptance criteria/i,
  /out of scope/i,
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
 * nothing. And `runTicket` — the ticket the run declaring it is working —
 * must not itself carry `readyDiscovery`: a ticket already born from a ready
 * discovery is one hop into a chain of unreviewed work, and a second hop
 * falls back to needs-triage rather than compounding it.
 */
function opensReady(runTicket: Ticket, discovery: Discovery): boolean {
  return (
    discovery.ready === true &&
    isAgentBrief(discovery.body) &&
    runTicket.readyDiscovery !== true
  );
}

/**
 * Files one discovery against `target`: a comment for a correction or a
 * clarification, a discovered ticket for a prerequisite — blocking `target`
 * — or a suggestion — no edge, opened ready per `opensReady` where either
 * declares itself one. For a comment, `runTicket` names what `discoveredBody`
 * says this was discovered while working, so a discovery landing on a
 * different ticket than the one that found it still reads in context; a
 * discovered ticket's own body names `target` that way instead —
 * `createDiscoveredTicket`'s callers build it from the ticket they were
 * handed, per `discoveredBody`, so it reads as discovered while working the
 * ticket it blocks or rides alongside, not the run that found it. `runTicket`
 * is also what `opensReady` reads for the chain guard, never `target`: it is
 * the ticket the run itself was working that may or may not have come from a
 * ready discovery, whatever ticket the discovery is filed against.
 */
async function fileDiscovery(
  tracker: Pick<IssueTracker, "comment" | "createDiscoveredTicket">,
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
  const ticket = await tracker.createDiscoveredTicket(target, {
    title: discovery.title,
    body: discovery.body,
    blocking: discovery.kind === "prerequisite",
    ready: opensReady(runTicket, discovery),
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
  tracker: Pick<IssueTracker, "comment" | "createDiscoveredTicket">,
  runTicket: Ticket,
  target: Ticket,
  discoveries: readonly Discovery[],
  discoveriesDropped = 0,
): Promise<DiscoveryRouting> {
  const filed: FiledDiscovery[] = [];
  const refused: RefusedDiscovery[] = [];
  let suggestionFiled = false;
  let suggestionsDropped = 0;

  for (const discovery of discoveries) {
    if (discovery.kind === "suggestion" && suggestionFiled) {
      suggestionsDropped += 1;
      continue;
    }
    try {
      filed.push(await fileDiscovery(tracker, runTicket, target, discovery));
      if (discovery.kind === "suggestion") {
        suggestionFiled = true;
      }
    } catch (error: unknown) {
      refused.push({ discovery, reason: errorMessage(error) });
    }
  }

  return { filed, suggestionsDropped, refused, discoveriesDropped };
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
  const { issues } = await tracker.listOpenIssues(ticket.repo);
  const parentNumber = issues.find(
    (issue) => issue.ticket.number === ticket.number,
  )?.parent;
  const parent =
    parentNumber === undefined
      ? undefined
      : issues.find((issue) => issue.ticket.number === parentNumber)?.ticket;
  if (parent !== undefined) {
    return { ticket: parent };
  }
  return {
    error: `could not find the ${targetNoun(ticket)} #${ticket.number} is a sub-issue of`,
  };
}

/**
 * `routeRunDiscoveries`'s answer: the target its discoveries were routed
 * against, what became of every one of them, and the run's own discoveries in
 * the order the agent filed them — for `hasBlockingDiscovery` and
 * `blockingDiscoveriesOf`, which read this rather than `routing`.
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
  discoveries: readonly Discovery[];
}

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
  tracker: Pick<IssueTracker, "listOpenIssues" | "comment" | "createDiscoveredTicket">,
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
      routing: { filed: [], suggestionsDropped: 0, refused: [], discoveriesDropped },
      discoveries: found,
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
        discoveriesDropped,
      },
      discoveries: found,
    };
  }
  const crossTarget =
    resolved.ticket.number === ticket.number ? undefined : resolved.ticket;
  return {
    target: resolved.ticket,
    ...(crossTarget !== undefined && { crossTarget }),
    routing: await routeDiscoveries(tracker, ticket, resolved.ticket, found, discoveriesDropped),
    discoveries: found,
  };
}
