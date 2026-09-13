import type {
  GaveUp,
  ModelRefused,
  UnusableModelLabel,
} from "./morning-run.ts";
import type {
  PullRequestUrl,
  ReviewRunResult,
  ReviewTicket,
  SandboxRunResult,
  Ticket,
} from "./ports/index.ts";
import {
  MODEL_LABEL_PREFIX,
  MODEL_NAME_SHAPE,
  READY_FOR_AGENT_LABEL,
  ticketKind,
} from "./ports/index.ts";

/**
 * What became of a failed run's branch when the loop discarded it, so that the
 * hand-back comment can say.
 */
export type Discard =
  /** There was none: the agent committed nothing, or never ran. */
  | { kind: "none" }
  /** Thrown away, as a failed run's branch should be. */
  | { kind: "discarded" }
  /** Still in the checkout, because git would not delete it. */
  | { kind: "kept"; reason: string };

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
 * Here rather than in the tracker's adapter, because trimming is only safe
 * before the quote is fenced: an adapter holding a finished body could cut it
 * only by cutting the fence off with it.
 */
const OUTPUT_QUOTED = 20_000;
const REASON_QUOTED = 4_000;

/**
 * What a ticket whose agent gave up is told about the morning that failed on
 * it: why it stopped, what the agent said, what became of its branch, and how
 * to send the ticket round again.
 *
 * Markdown, because that is what a ticket comment is read as — and so the
 * agent's own output is fenced, since anything it said unfenced would be read
 * as Markdown too.
 */
export function handbackComment(
  failure: GaveUp,
  run: SandboxRunResult | undefined,
  discard: Discard,
): string {
  return [
    `The morning loop ran this ticket and the agent gave up.`,
    `Why it stopped: ${tail(failure.reason, REASON_QUOTED)}`,
    `What it said:\n\n${quote(run?.output ?? "")}`,
    ...branchNote(run, discard),
    notRetried(),
  ].join("\n\n");
}

/**
 * What a review ticket is told when its review did not finish: the agent gave
 * up, or finished without posting. The pull request is not checked for a
 * comment from an agent that gave up — whatever it posted is not a finished
 * review — so either way the ticket is the developer's again.
 */
export function reviewHandbackComment(
  ticket: ReviewTicket,
  review: ReviewRunResult,
): string {
  const what =
    review.failure === undefined
      ? [
          `The morning loop ran this review and the agent finished, but posted nothing to ${ticket.pullRequest}.`,
        ]
      : [
          `The morning loop ran this review and the agent gave up.`,
          `Why it stopped: ${tail(review.failure, REASON_QUOTED)}`,
        ];
  return [
    ...what,
    `What it said:\n\n${quote(review.output)}`,
    notRetried(),
  ].join("\n\n");
}

/**
 * What a ticket is told when the agent CLI refused the model its run was
 * started on: which model, what named it, and the CLI's own words — so the
 * developer fixes the model rather than the ticket's wording, which an agent
 * that never started has said nothing about.
 */
export function modelRefusalComment(
  ticket: Ticket,
  failure: ModelRefused,
  run: SandboxRunResult | undefined,
  discard: Discard,
): string {
  const model = `\`${failure.refusal.model}\``;
  const [named, fix] =
    failure.source === "model label"
      ? [
          `its model label, \`${MODEL_LABEL_PREFIX}${failure.refusal.model}\``,
          `fix or remove its model label`,
        ]
      : [
          `the model defaults for ${ticketKind(ticket)} tickets, in \`models.json\``,
          `fix the ${ticketKind(ticket)} model in \`models.json\`, or give this ticket a model label`,
        ];
  return [
    `The morning loop did not work this ticket: the agent CLI refused the model ${model}, named by ${named}.`,
    `What the CLI said:\n\n${quote(failure.refusal.words)}`,
    ...branchNote(run, discard),
    notRetried(fix),
  ].join("\n\n");
}

/**
 * What a ticket is told when its model labels named no model a run could be
 * started on. Said at selection, so there is no run, branch or output to name.
 */
export function unusableModelLabelComment(failure: UnusableModelLabel): string {
  const labels = failure.labels.map((label) => `\`${label}\``).join(", ");
  const [what, fix] =
    failure.kind === "conflicting-model-labels"
      ? [
          `it carries more than one model label (${labels}), and there is no telling which model it should run on`,
          `keep one of them`,
        ]
      : [
          `its model label names no model a run could be started on (${labels}): a model label is \`${MODEL_LABEL_PREFIX}<name>\`, with ${MODEL_NAME_SHAPE}`,
          `fix or remove it`,
        ];
  return [
    `The morning loop did not run this ticket: ${what}. Nothing was run and nothing was spent.`,
    notRetried(fix),
  ].join("\n\n");
}

/**
 * What a finished run's ticket is told once its work is waiting in a draft
 * pull request: where to find it, and that the ticket itself is out of the
 * queue.
 *
 * Names the review ticket as well as the pull request, since both are new
 * and the ticket comment is where the developer is most likely to read them
 * together.
 */
export function handoverComment(
  pullRequest: PullRequestUrl,
  reviewTicket: Ticket,
): string {
  return [
    `The morning loop finished this ticket. Its work is waiting in a draft pull request: ${pullRequest}`,
    `A review has been queued as #${reviewTicket.number}.`,
    `This ticket is yours again: it will not be retried.`,
  ].join("\n\n");
}

/**
 * What a finished run's ticket is told when the run left nothing to review:
 * the agent finished without committing anything, so there is no pull
 * request and no review to name.
 *
 * Quotes what the agent said, exactly as `handbackComment` does for an agent
 * that gave up. This comment used to say only that nothing was committed, and
 * a run that commits nothing is precisely the run whose output nobody can
 * infer: there is no branch to read and no pull request to open, so the output
 * is the whole of the evidence. Dropping it hid a sandbox that was refusing
 * the agent every tool it had — eighteen tickets were handed back as work the
 * agent declined to do, each carrying a comment that said nothing about why.
 */
export function committedNothingComment(
  run: SandboxRunResult | undefined,
): string {
  return [
    `The morning loop ran this ticket and committed nothing.`,
    `What it said:\n\n${quote(run?.output ?? "")}`,
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
function branchNote(
  run: SandboxRunResult | undefined,
  discard: Discard,
): string[] {
  switch (discard.kind) {
    case "none":
      return [];
    case "discarded":
      return [`The branch it worked on has been discarded.`];
    case "kept":
      return [
        `Its branch \`${run?.branch ?? ""}\` could not be discarded, so it is still in the checkout: ${tail(discard.reason, REASON_QUOTED)}`,
      ];
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

/** The last `limit` characters of `text`, marked as a tail when it is one. */
function tail(text: string, limit: number): string {
  return text.length <= limit ? text : `…${text.slice(-limit)}`;
}
