import type {
  AheadOfGateFailure,
  GaveUp,
  Handover,
  HandoverFailed,
  HandoverReach,
  ModelRefused,
  UnsettledMergeability,
} from "./iteration-outcome.ts";
import type {
  Branch,
  Checkout,
  CommitSha,
  IssueTracker,
  PullRequestUrl,
  RepoHost,
  RunFinished,
  RunGaveUp,
  RunLimitRefused,
  RunModelRefused,
  RunProviderFailed,
  Salvaged,
  Ticket,
  TranscriptPath,
} from "./ports/index.ts";
import {
  MODEL_LABEL_PREFIX,
  MODEL_NAME_SHAPE,
  READY_FOR_AGENT_LABEL,
  SIZE_LABEL_PREFIX,
  SIZES,
  ticketKind,
} from "./ports/index.ts";
import { errorMessage } from "./error-message.ts";
import { tail } from "./tail.ts";

/**
 * What became of a failed run's branch when the loop discarded it, so that
 * the hand-back comment can say.
 */
export type Discard =
  /** There was none: the agent committed nothing, or never ran. */
  | { kind: "none" }
  /** Thrown away, as a failed run's branch should be. */
  | { kind: "discarded" }
  /** Still in the checkout, because git would not delete it. */
  | { kind: "kept"; reason: string }
  /**
   * Kept in the checkout on purpose, and recorded against the ticket: see
   * CONTEXT.md's "Salvage". Carries the branch and the ticket's own count of
   * limit refusals in a row, the salvage record's own fields, so the summary
   * can name both. Never built from a gave-up or model-refused run — only a
   * limit refusal's branch reaches this type — so no comment this module
   * writes for either ever names it.
   */
  | ({ kind: "salvaged" } & Salvaged);

/**
 * What became of the loop's own attempt to give a ticket back to the
 * developer: relabelled ready-for-human, found already closed by an
 * overlapping run, or the tracker call itself refused — carrying why. One
 * shape, for a failed iteration and a finished one alike, so whether a
 * ticket was handed back is never recorded two different ways.
 */
export type HandBackRecord =
  | { outcome: "handed-back" }
  | { outcome: "already-closed" }
  /** The tracker call itself failed, carrying why: the ticket is left exactly as it was, still ready-for-agent, and comes round again until somebody relabels it by hand. */
  | { outcome: "refused"; reason: string };

/**
 * How much of the agent's output, and of one failure reason, the ticket
 * comment carries.
 *
 * A tracker takes a comment of bounded size, and a failed `execFile` carries
 * every byte the command wrote to stderr — so a comment that quoted either in
 * full would be rejected, and a rejected comment is a ticket that never gets
 * handed back. The tail is kept, because it holds whatever the thing was doing
 * when it stopped.
 *
 * Trimmed here rather than in the tracker's adapter, because trimming is only
 * safe before the quote is fenced: an adapter holding a finished comment body
 * could cut it only by cutting the fence off with it.
 */
const OUTPUT_QUOTED = 20_000;
/**
 * Exported so a bound built for a failure reason elsewhere (`container-sandbox.ts`'s
 * `FAILURE_STDERR_TAIL`) can stay comfortably under it, rather than agreeing
 * with it only by coincidence.
 */
export const REASON_QUOTED = 4_000;

/** The two outside-world ports hand-back needs: the tracker to comment and relabel, the repo host to discard a branch. */
export interface HandBackPorts {
  tracker: IssueTracker;
  repoHost: RepoHost;
}

/**
 * What a gave-up hand-back's comment needs beyond `GaveUp.reason`, particular
 * to which kind of ticket gave up — matching `ticketKind`, so a ticket kind
 * added there is a case this has to answer too. An implementation run always
 * leaves a branch behind to discard; a review's never does; an apply-review
 * or rebase run leaves neither, but names the pull request its comment
 * points at, and may say which head a rejected push found it moved to.
 */
type GaveUpContext = (
  | { ticketKind: "implementation"; output: string; checkout: Checkout; run: RunGaveUp }
  | { ticketKind: "review"; output: string }
  | {
      ticketKind: "apply-review";
      output: string;
      pullRequest: PullRequestUrl;
      movedHead?: CommitSha;
    }
  | {
      ticketKind: "rebase";
      output: string;
      pullRequest: PullRequestUrl;
      movedHead?: CommitSha;
    }
) & {
  /**
   * Where the run's session transcript landed, absent when none was ever
   * found — so the comment can tell whoever picks the ticket back up where to
   * read it, rather than only the morning summary knowing.
   */
  transcript?: TranscriptPath;
};

/**
 * How one iteration ended, for the one ticket it selected — everything
 * `handBack` needs to decide the branch, pick the comment and say what
 * happened. Told apart by `kind`, matching the ways CONTEXT.md's Hand back
 * happens: an agent gave up, the agent CLI refused a model, a ticket's model
 * labels named none it could use, a rebase ticket's mergeability never
 * settled, a finished run's handover failed part way, or a run finished, with
 * or without a handover.
 *
 * Every kind but `"finished"` is exactly the `RunFailure` its own iteration
 * is built from, plus only what the comment needs beyond `reason` — never a
 * second description of the same failure a caller has to keep in step with
 * the one it builds for `Failed.failure`.
 */
export type HandBackEnding =
  | (GaveUp & GaveUpContext)
  | HandoverFailed
  | (ModelRefused & {
      /** The branch the refused run left. Present only for an implementation ticket, which is the only kind a model refusal leaves one for. */
      worked?: { checkout: Checkout; run: RunModelRefused };
    })
  | AheadOfGateFailure
  | (UnsettledMergeability & { pullRequest: PullRequestUrl })
  | { kind: "finished"; run: RunFinished; handover?: Handover };

/**
 * Gives `ticket` back to the developer for `ending`: discards its branch when
 * `ending` left one behind, picks the comment `ending` calls for, and
 * relabels the tracker from ready-for-agent to ready-for-human — or finds it
 * already closed by an overlapping run, or finds the tracker itself refuses.
 *
 * Never throws. A tracker that cannot be reached is exactly the case the
 * `"refused"` outcome exists to report, and saying so is the one thing still
 * worth doing.
 */
export async function handBack(
  ports: HandBackPorts,
  ticket: Ticket,
  ending: HandBackEnding,
): Promise<HandBackRecord> {
  const discard = await discardIfWorked(ports.repoHost, ending);
  const comment = commentFor(ticket, ending, discard);
  try {
    const outcome = await ports.tracker.handBack(ticket, comment);
    return { outcome };
  } catch (error: unknown) {
    return { outcome: "refused", reason: errorMessage(error) };
  }
}

/**
 * Throws a failed run's branch away, and says what became of it. Exported so
 * a cut-off run — a limit refusal or a provider failure, never handed back,
 * since the provider is the problem, not the ticket — can discard its branch
 * the same way without going through `handBack`.
 *
 * Never throws. A branch that will not delete is worth telling the developer
 * about; it is not worth the ticket, which is what refusing to go on would
 * cost.
 */
export async function discardBranch(
  repoHost: RepoHost,
  checkout: Checkout,
  run: RunGaveUp | RunLimitRefused | RunModelRefused | RunProviderFailed,
): Promise<Discard> {
  // The sandbox fetches a branch back only when the agent committed to it, and
  // an agent that gave up commonly committed nothing at all.
  if (run.commits.length === 0) {
    return { kind: "none" };
  }
  try {
    await repoHost.discardBranch(checkout, run.branch);
    return { kind: "discarded" };
  } catch (error: unknown) {
    return { kind: "kept", reason: errorMessage(error) };
  }
}

/** Discards the branch `ending` left behind, when it left one — none but a gave-up or a worked model refusal ever does. */
async function discardIfWorked(
  repoHost: RepoHost,
  ending: HandBackEnding,
): Promise<Discard> {
  if (ending.kind === "gave-up" && ending.ticketKind === "implementation") {
    return discardBranch(repoHost, ending.checkout, ending.run);
  }
  if (ending.kind === "model-refused" && ending.worked !== undefined) {
    return discardBranch(repoHost, ending.worked.checkout, ending.worked.run);
  }
  return { kind: "none" };
}

/** Picks the one comment `ending` calls for. */
function commentFor(ticket: Ticket, ending: HandBackEnding, discard: Discard): string {
  switch (ending.kind) {
    case "gave-up":
      return gaveUpCommentFor(ending, discard);
    case "model-refused":
      return modelRefusalComment(ticket, ending, discard);
    case "conflicting-model-labels":
      return notRunAheadOfGateComment(
        `it carries more than one model label (${labelList(ending.labels)}), and there is no telling which model it should run on`,
        "keep one of them",
      );
    case "unusable-model-label":
      return notRunAheadOfGateComment(
        `its model label names no model a run could be started on (${labelList(ending.labels)}): a model label is \`${MODEL_LABEL_PREFIX}<name>\`, with ${MODEL_NAME_SHAPE}`,
        "fix or remove it",
      );
    case "unusable-size-label":
      return notRunAheadOfGateComment(
        `its size label names no size the budget document knows (${labelList(ending.labels)}): a size label is \`${SIZE_LABEL_PREFIX}<size>\`, one of ${SIZES.join(", ")}`,
        "fix or remove it",
      );
    case "unsettled-mergeability":
      return unsettledMergeabilityComment(ending);
    case "handover-failed":
      return handoverFailedComment(ending);
    case "finished":
      return ending.handover === undefined
        ? committedNothingComment(ending.run)
        : handoverComment(ending.handover.pullRequest, ending.handover.reviewTicket);
  }
}

/** The gave-up comment for whichever kind of ticket `ending.ticketKind` names. */
function gaveUpCommentFor(ending: GaveUp & GaveUpContext, discard: Discard): string {
  const notes = ((): string[] => {
    switch (ending.ticketKind) {
      case "implementation":
        return branchNote(ending.run.branch, discard);
      case "review":
        return [];
      case "apply-review":
        // A pull request is marked ready for review only once every thread on
        // it is answered, so a gave-up run — which answered none, or left one
        // unanswered — always finds it still a draft.
        return [...movedHeadNote(ending.movedHead), `${ending.pullRequest} is still a draft.`];
      case "rebase":
        // Never claims the pull request is a draft, unlike an apply-review's:
        // `/rebase` can be commented on one already marked ready, and a
        // rebase leaves its draft state exactly as it found it either way.
        return [...movedHeadNote(ending.movedHead), untouchedDraftState(ending.pullRequest)];
    }
  })();
  return gaveUpComment(ending.reason, ending.output, notes, ending.transcript);
}

/**
 * What a ticket is told when a rebase ticket's mergeability never settled: no
 * run started, so there is nothing to discard and nothing spent.
 */
function unsettledMergeabilityComment(
  ending: UnsettledMergeability & { pullRequest: PullRequestUrl },
): string {
  return [
    `The morning loop did not run this ticket: ${tail(ending.reason, REASON_QUOTED)}`,
    untouchedDraftState(ending.pullRequest),
    notRetried(),
  ].join("\n\n");
}

/**
 * What a ticket is told when a finished run's handover failed part way: where
 * its work is, so the developer picks it up rather than re-running a ticket
 * whose work already exists.
 */
function handoverFailedComment(ending: HandoverFailed): string {
  return [
    `The morning loop finished this ticket, but could not hand its work over: ${tail(ending.reason, REASON_QUOTED)}`,
    `Its work is on the branch ${workLocation(ending, (text) => `\`${text}\``)}.`,
    `This ticket is yours again: it will not be retried.`,
  ].join("\n\n");
}

/** The layout every gave-up comment shares, with `notes` before the last line. */
function gaveUpComment(
  reason: string,
  output: string,
  notes: string[],
  transcript: TranscriptPath | undefined,
): string {
  return [
    `The morning loop ran this ticket and the agent gave up.`,
    `Why it stopped: ${tail(reason, REASON_QUOTED)}`,
    `What it said:\n\n${quote(output)}`,
    ...notes,
    notRetried(),
    ...transcriptLine(transcript),
  ].join("\n\n");
}

/**
 * The comment's own last line naming where the run's session transcript
 * landed, empty when it left none — so a ticket handed back for a run with no
 * transcript reads exactly as it did before this line existed.
 */
function transcriptLine(transcript: TranscriptPath | undefined): string[] {
  return transcript === undefined ? [] : [`Transcript: \`${transcript}\`.`];
}

/** Says which head a rejected push found the branch on, when that is why the run gave up. */
function movedHeadNote(movedHead: CommitSha | undefined): string[] {
  return movedHead === undefined
    ? []
    : [
        `Its push was rejected: the pull request's branch had moved to \`${movedHead}\` on the repo host, so what it committed never reached the pull request.`,
      ];
}

function untouchedDraftState(pullRequest: PullRequestUrl): string {
  return `${pullRequest}'s draft state was left as it was.`;
}

/**
 * What a ticket is told when the agent CLI refused the model its run was
 * started on: which model, what named it, and the CLI's own words — so the
 * developer fixes the model rather than the ticket's wording, which an agent
 * that never started has said nothing about.
 */
function modelRefusalComment(
  ticket: Ticket,
  ending: ModelRefused & { worked?: { checkout: Checkout; run: RunModelRefused } },
  discard: Discard,
): string {
  const model = `\`${ending.refusal.model}\``;
  const [named, fix] =
    ending.source === "model label"
      ? [
          `its model label, \`${MODEL_LABEL_PREFIX}${ending.refusal.model}\``,
          `fix or remove its model label`,
        ]
      : [
          `the model defaults for ${ticketKind(ticket)} tickets, in \`models.json\``,
          `fix the ${ticketKind(ticket)} model in \`models.json\`, or give this ticket a model label`,
        ];
  return [
    `The morning loop did not work this ticket: the agent CLI refused the model ${model}, named by ${named}.`,
    `What the CLI said:\n\n${quote(ending.refusal.words)}`,
    ...branchNote(ending.worked?.run.branch, discard),
    notRetried(fix),
  ].join("\n\n");
}

function labelList(labels: readonly string[]): string {
  return labels.map((label) => `\`${label}\``).join(", ");
}

/**
 * What a ticket is told when it is handed back ahead of the gate: its model
 * labels named no model a run could be started on, or its size label names no
 * size the budget document knows. Said at selection, so there is no run,
 * branch or output to name.
 */
function notRunAheadOfGateComment(what: string, fix: string): string {
  return [
    `The morning loop did not run this ticket: ${what}. Nothing was run and nothing was spent.`,
    notRetried(fix),
  ].join("\n\n");
}

/**
 * What a finished run's ticket is told once its work is waiting in a draft
 * pull request: where to find it, and that the ticket itself is out of the
 * queue. Names the review ticket as well as the pull request, since both are
 * new and the ticket comment is where the developer is most likely to read
 * them together.
 */
function handoverComment(pullRequest: PullRequestUrl, reviewTicket: Ticket): string {
  return [
    `The morning loop finished this ticket. Its work is waiting in a draft pull request: ${pullRequest}`,
    `A review has been queued as #${reviewTicket.number}.`,
    `This ticket is yours again: it will not be retried.`,
  ].join("\n\n");
}

/**
 * Where a failed handover left the work: its branch, and how far that got.
 * The one wording of it, for the summary and the ticket comment alike;
 * `code` marks up the branch and checkout where the reader renders it.
 */
export function workLocation(
  failure: { branch: Branch; where: HandoverReach },
  code: (text: string) => string = (text) => text,
): string {
  const branch = code(failure.branch);
  switch (failure.where.kind) {
    case "unpushed":
      return `${branch} (not pushed: only in the checkout at ${code(failure.where.checkout)})`;
    case "pushed":
      return branch;
    case "opened":
      return `${branch} (draft pull request ${failure.where.pullRequest})`;
  }
}

/**
 * What a finished run's ticket is told when the run left nothing to review:
 * the agent finished without committing anything, so there is no pull
 * request and no review to name.
 *
 * Quotes what the agent said, as `gaveUpComment` does for an agent that gave
 * up. A run that commits nothing is precisely the run whose output nobody can
 * infer any other way: there is no branch to read and no pull request to
 * open, so the output is the whole of the evidence — a sandbox refusing the
 * agent every tool it had once went unnoticed across eighteen tickets in a
 * row because their comments said only that nothing was committed.
 */
function committedNothingComment(run: RunFinished): string {
  return [
    `The morning loop ran this ticket and committed nothing.`,
    `What it said:\n\n${quote(run.output)}`,
    notRetried(),
  ].join("\n\n");
}

/**
 * The line a handed-back ticket's comment ends on: the ticket is the
 * developer's again, and what sends it round another morning — after `fix`,
 * where there is something to fix first.
 */
function notRetried(fix?: string): string {
  const sendRound = `add ${READY_FOR_AGENT_LABEL} back to send it round another morning`;
  return `This ticket is yours again and will not be retried: ${fix === undefined ? sendRound : `${fix}, then ${sendRound}`}.`;
}

/** What the developer will find in the checkout, when it is worth saying. */
function branchNote(branchName: Branch | undefined, discard: Discard): string[] {
  switch (discard.kind) {
    case "none":
      return [];
    case "discarded":
      return [`The branch it worked on has been discarded.`];
    case "kept":
      return [
        `Its branch \`${branchName ?? ""}\` could not be discarded, so it is still in the checkout: ${tail(discard.reason, REASON_QUOTED)}`,
      ];
    // Unreachable from here: the comments this module writes are a gave-up
    // run's and a model refusal's, and neither ever salvages a branch. Kept
    // for the switch to stay exhaustive against every `Discard`.
    case "salvaged":
      return [];
  }
}

/** The tail of `output`, fenced, and said to be a tail when it is one. */
function quote(output: string): string {
  const said = tail(output.trim(), OUTPUT_QUOTED);
  if (said === "") {
    return "_(it said nothing)_";
  }
  // A coding agent quotes code, so its output holds fences of its own. The
  // fence has to outrun the longest run of backticks inside it, or the rest of
  // the output stops being quoted and starts being Markdown — with every
  // `#123` in it becoming a cross-reference on somebody else's issue.
  const longest = Math.max(
    0,
    ...[...said.matchAll(/`+/g)].map((of) => of[0].length),
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${said}\n${fence}`;
}
