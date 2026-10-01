import type {
  AheadOfGateFailure,
  GaveUp,
  Handover,
  HandoverFailed,
  HandoverReach,
  ModelRefused,
  UniformFilesTouched,
  UnsettledMergeability,
} from "./iteration-outcome.ts";
import type {
  Branch,
  Checkout,
  CommitSha,
  Discovery,
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
  targetNoun,
  ticketReference,
} from "./ports/index.ts";
import { errorMessage } from "./error-message.ts";
import { modelProblem } from "./model-resolution.ts";
import { sizeProblem } from "./size-resolution.ts";
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
 * The branch a finished, gave-up or cut-off implementation run left, worth
 * discarding when its ticket is handed back instead of finishing normally —
 * named once so a kind added to the union is one edit, not two kept in step
 * by hand.
 */
export type WorkedBranch = {
  checkout: Checkout;
  run: RunFinished | RunGaveUp | RunLimitRefused | RunProviderFailed;
};

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
 *
 * `transcript` names where the run's session transcript landed, absent when
 * none was ever found — so the comment can tell whoever picks the ticket
 * back up where to read it, rather than only the morning summary knowing.
 * Carried here only for the three kinds with no run of their own to read it
 * from; an implementation's is `ending.run.transcript`.
 */
type GaveUpContext =
  | { ticketKind: "implementation"; output: string; checkout: Checkout; run: RunGaveUp }
  | { ticketKind: "review"; output: string; transcript?: TranscriptPath }
  | { ticketKind: "spec-review"; output: string; transcript?: TranscriptPath }
  | { ticketKind: "ux-review"; output: string; transcript?: TranscriptPath }
  | {
      ticketKind: "apply-review";
      output: string;
      pullRequest: PullRequestUrl;
      movedHead?: CommitSha;
      transcript?: TranscriptPath;
    }
  | {
      ticketKind: "rebase";
      output: string;
      pullRequest: PullRequestUrl;
      movedHead?: CommitSha;
      transcript?: TranscriptPath;
    };

/**
 * What a uniform-files-touched hand-back's comment needs beyond
 * `UniformFilesTouched.files`, particular to which kind of ticket the
 * diff or push came from. An implementation run's diff never reached the
 * repo host, so its branch is kept in the checkout, unpushed, for the
 * developer to still have a diff to read. An apply-review or rebase run's
 * push already reached the repo host before this: the sandbox itself
 * (`container-sandbox.ts`'s `revertPushIfUniformFilesTouched`) has already
 * tried forcing the pull request's branch back to where it stood before the
 * run, so there is no branch to name here, only the pull request, and —
 * present only when that force-back itself failed — why it is still there.
 */
type UniformFilesTouchedContext =
  | { ticketKind: "implementation"; checkout: Checkout; run: RunFinished }
  | {
      ticketKind: "apply-review" | "rebase";
      pullRequest: PullRequestUrl;
      notReverted?: { reason: string };
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
 * Every kind but `"finished"`, `"spec-review-finished"` and `"ux-review-finished"` is
 * exactly the `RunFailure` its own iteration is built from, plus only what
 * the comment needs beyond `reason` — never a second description of the same
 * failure a caller has to keep in step with the one it builds for
 * `Failed.failure`.
 *
 * `"spec-review-finished"` and `"ux-review-finished"` are each their own case
 * rather than a share of `"finished"`: neither run ever creates a branch, so
 * neither has a `RunFinished` to carry, and its own report is what becomes
 * the comment in place of a handover — see `Sandbox.specReview` and
 * `Sandbox.uxReview`.
 */
export type HandBackEnding =
  | (GaveUp & GaveUpContext)
  | (HandoverFailed & { transcript?: TranscriptPath })
  | (ModelRefused & {
      /** The branch the refused run left. Present only for an implementation ticket, which is the only kind a model refusal leaves one for. */
      worked?: { checkout: Checkout; run: RunModelRefused };
      transcript?: TranscriptPath;
    })
  | AheadOfGateFailure
  | (UnsettledMergeability & { pullRequest: PullRequestUrl })
  | (UniformFilesTouched & UniformFilesTouchedContext)
  | { kind: "finished"; run: RunFinished; handover?: Handover }
  | { kind: "spec-review-finished"; output: string; transcript?: TranscriptPath }
  | { kind: "ux-review-finished"; output: string; transcript?: TranscriptPath }
  | {
      kind: "discovery-blocked";
      /** The correction and/or prerequisite discoveries that stopped this ticket's run from finishing normally, in the order the agent filed them. */
      discoveries: Discovery[];
      /**
       * The ticket those discoveries were routed against, present only when
       * it differs from the ticket being handed back — a pull request or a
       * spec review ticket's run, whose discoveries land on its
       * implementation ticket or supertask instead of the ticket handed
       * back here.
       */
      crossTarget?: Ticket;
      /**
       * The branch a finished, gave-up or cut-off implementation run left.
       * Present only for an implementation ticket, the only kind with one to
       * discard.
       */
      worked?: WorkedBranch;
      /**
       * The run's own report, present only for a spec review or ux review
       * ticket: it has nowhere else to post its findings, so the discovery
       * that blocked it would otherwise throw the rest of the report away.
       */
      output?: string;
      transcript?: TranscriptPath;
    };

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
 * the same way without going through `handBack`. Also what a finished run's
 * branch gets when a blocking discovery hands its ticket back instead of
 * opening it as a pull request — per CONTEXT.md's "Discard", exactly as a
 * gave-up run's branch is discarded, whatever the agent went on to commit.
 *
 * Never throws. A branch that will not delete is worth telling the developer
 * about; it is not worth the ticket, which is what refusing to go on would
 * cost.
 */
export async function discardBranch(
  repoHost: RepoHost,
  checkout: Checkout,
  run: RunFinished | RunGaveUp | RunLimitRefused | RunModelRefused | RunProviderFailed,
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

/**
 * Discards the branch `ending` left behind, when it left one to discard —
 * none but a gave-up, a worked model refusal, or a worked discovery block
 * ever does. An implementation run whose diff touched a uniform file is never
 * discarded here: its branch is left unpushed instead, the way
 * `handoverFailed`'s is — the ticket is handed back naming the files, not
 * thrown away. An apply-review or rebase run whose push touched one leaves no
 * branch at all: the sandbox already tried forcing the push itself back, on
 * the repo host, before this ever runs.
 */
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
  if (ending.kind === "discovery-blocked" && ending.worked !== undefined) {
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
    case "conflicting-model-labels": {
      const { problem, fix } = modelProblem(ticket, ending);
      return notRunAheadOfGateComment(problem, fix);
    }
    case "unusable-model-label": {
      const { problem, fix } = modelProblem(ticket, ending);
      return notRunAheadOfGateComment(
        `${problem}: a model label is \`${MODEL_LABEL_PREFIX}<name>\`, with ${MODEL_NAME_SHAPE}`,
        fix,
      );
    }
    case "unusable-size-label": {
      const { problem, fix } = sizeProblem(ending);
      return notRunAheadOfGateComment(
        `${problem}: a size label is \`${SIZE_LABEL_PREFIX}<size>\`, one of ${SIZES.join(", ")}`,
        fix,
      );
    }
    case "unsettled-mergeability":
      return unsettledMergeabilityComment(ending);
    case "handover-failed":
      return handoverFailedComment(ending);
    case "uniform-files-touched":
      return uniformFilesTouchedComment(ending);
    case "finished":
      return ending.handover === undefined
        ? committedNothingComment(ending.run)
        : handoverComment(ending.handover.pullRequest, ending.handover.reviewTicket);
    case "spec-review-finished":
      return findingsComment("spec review", ending);
    case "ux-review-finished":
      return findingsComment("ux review", ending);
    case "discovery-blocked":
      return discoveryBlockedComment(ticket, ending, discard);
  }
}

/** The gave-up comment for whichever kind of ticket `ending.ticketKind` names. */
function gaveUpCommentFor(ending: GaveUp & GaveUpContext, discard: Discard): string {
  const [notes, transcript] = ((): [string[], TranscriptPath | undefined] => {
    switch (ending.ticketKind) {
      case "implementation":
        return [branchNote(ending.run.branch, discard), ending.run.transcript];
      case "review":
      case "spec-review":
      case "ux-review":
        return [[], ending.transcript];
      case "apply-review":
        // A pull request is marked ready for review only once every thread on
        // it is answered, so a gave-up run — which answered none, or left one
        // unanswered — always finds it still a draft.
        return [
          [...movedHeadNote(ending.movedHead), `${ending.pullRequest} is still a draft.`],
          ending.transcript,
        ];
      case "rebase":
        // Never claims the pull request is a draft, unlike an apply-review's:
        // `/rebase` can be commented on one already marked ready, and a
        // rebase leaves its draft state exactly as it found it either way.
        return [
          [...movedHeadNote(ending.movedHead), untouchedDraftState(ending.pullRequest)],
          ending.transcript,
        ];
    }
  })();
  return gaveUpComment(ending.reason, ending.output, notes, transcript);
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
function handoverFailedComment(ending: HandoverFailed & { transcript?: TranscriptPath }): string {
  return [
    `The morning loop finished this ticket, but could not hand its work over: ${tail(ending.reason, REASON_QUOTED)}`,
    `Its work is on the branch ${workLocation(ending, (text) => `\`${text}\``)}.`,
    `This ticket is yours again: it will not be retried.`,
    ...transcriptNote(ending.transcript),
  ].join("\n\n");
}

/**
 * What a ticket is told when a run's diff or push touched a file the manager
 * keeps uniform across every project: which files, and how the response
 * differed by where the touch was caught. An implementation run's diff never
 * reached the repo host, so its branch is left unpushed for the developer to
 * read. An apply-review or rebase run's push already reached the repo host,
 * so the sandbox itself tried forcing the pull request's branch back to where
 * it stood before the run — leaving no branch here to name, only the pull
 * request — and says so only when that force-back failed, naming why the
 * touch is still on the pull request's branch.
 */
function uniformFilesTouchedComment(
  ending: UniformFilesTouched & UniformFilesTouchedContext,
): string {
  const files = ending.files.map((file) => `\`${file}\``).join(", ");
  if (ending.ticketKind === "implementation") {
    return [
      `The morning loop finished this ticket, but its diff touches a file the manager keeps uniform across every project: ${files}.`,
      `No pull request was opened for it — that would leave this project's own copy drifting from the one source.`,
      `Its work is on the branch ${workLocation(
        { branch: ending.run.branch, where: { kind: "unpushed", checkout: ending.checkout } },
        (text) => `\`${text}\``,
      )}.`,
      notRetried(),
      ...transcriptNote(ending.run.transcript),
    ].join("\n\n");
  }
  const reverted =
    ending.notReverted === undefined
      ? `The push has been reverted — that would leave this project's own copy drifting from the one source —`
      : `The push could not be reverted (${tail(ending.notReverted.reason, REASON_QUOTED)}), and is still on the pull request's branch — it would leave this project's own copy drifting from the one source —`;
  return [
    `The morning loop ran this ticket, but its push to ${ending.pullRequest} touches a file the manager keeps uniform across every project: ${files}.`,
    `${reverted} and ${untouchedDraftState(ending.pullRequest)}`,
    notRetried(),
    ...transcriptNote(ending.transcript),
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
    ...transcriptNote(transcript),
  ].join("\n\n");
}

/**
 * The comment's own last line naming where the run's session transcript
 * landed, empty when it left none.
 */
function transcriptNote(transcript: TranscriptPath | undefined): string[] {
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
  ending: ModelRefused & {
    worked?: { checkout: Checkout; run: RunModelRefused };
    transcript?: TranscriptPath;
  },
  discard: Discard,
): string {
  const { problem, fix } = modelProblem(ticket, ending);
  return [
    `The morning loop did not work this ticket: ${problem}.`,
    `What the CLI said:\n\n${quote(ending.refusal.words)}`,
    ...branchNote(ending.worked?.run.branch, discard),
    notRetried(fix),
    ...transcriptNote(ending.transcript),
  ].join("\n\n");
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
 * What a spec review or ux review ticket is told once its run finished: its
 * own report, verbatim, since that report — not a pull request comment, which
 * neither has anywhere to post — is the whole of its findings, and the ticket
 * itself is how they reach the developer, per CONTEXT.md's "Spec review
 * ticket" and "UX review ticket".
 */
function findingsComment(
  kind: "spec review" | "ux review",
  ending: { output: string; transcript?: TranscriptPath },
): string {
  return [
    `The morning loop ran this ${kind} ticket. What it found:\n\n${quote(ending.output)}`,
    ...truncationNote(ending.output, ending.transcript),
    notRetried(),
    ...transcriptNote(ending.transcript),
  ].join("\n\n");
}

/**
 * What a ticket is told when its run filed a blocking discovery: a
 * correction or a prerequisite, in the agent's own words — never described as
 * a run that gave up, even when the same run also did. `crossTarget`, present
 * only for a pull request or a spec review ticket, names the implementation
 * ticket or the supertask the discoveries were separately filed against;
 * inlined here regardless, so the ticket being handed back carries the whole
 * of what was found even if that other write was itself refused. `output`,
 * present only for a spec review or ux review ticket, is its run's own report,
 * inlined for the same reason: neither has anywhere else to post it, so the
 * discovery that blocked it would otherwise throw the rest of the report
 * away.
 */
function discoveryBlockedComment(
  ticket: Ticket,
  ending: Extract<HandBackEnding, { kind: "discovery-blocked" }>,
  discard: Discard,
): string {
  const findings = ending.discoveries
    .map((discovery) => `**${discovery.kind}**: ${discovery.title}\n\n${discovery.body}`)
    .join("\n\n---\n\n");
  return [
    `The morning loop ran this ticket and found a blocking discovery: a correction or a prerequisite, not a run that gave up.`,
    findings,
    ...(ending.crossTarget === undefined
      ? []
      : [`Also filed against the ${targetNoun(ticket)}, ${ticketReference(ending.crossTarget)}.`]),
    ...(ending.output === undefined
      ? []
      : [
          `The rest of what the review found:\n\n${quote(ending.output)}`,
          ...truncationNote(ending.output, ending.transcript),
        ]),
    ...branchNote(ending.worked?.run.branch, discard),
    notRetried(),
    ...transcriptNote(ending.transcript),
  ].join("\n\n");
}

/**
 * Warns that `quote` kept only the tail of a report, when it did: unlike
 * every other caller of `quote`, this one's output is the deliverable, not a
 * trailing symptom, so a report long enough to be cut loses its summary and
 * highest-priority findings rather than whatever it was doing when it
 * stopped.
 */
function truncationNote(
  output: string,
  transcript: TranscriptPath | undefined,
): string[] {
  if (output.trim().length <= OUTPUT_QUOTED) {
    return [];
  }
  return [
    transcript === undefined
      ? "This comment carries only the tail of the report: the earliest findings were cut to fit, and this run left no transcript to find the rest in."
      : "This comment carries only the tail of the report: the earliest findings were cut to fit; the transcript below has the rest.",
  ];
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
    // Unreachable from here: every comment this module writes calls
    // `discardBranch` at most, and that never salvages a branch — only
    // `morning-run.ts`'s own cut-off handling does. Kept for the switch to
    // stay exhaustive against every `Discard`.
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
