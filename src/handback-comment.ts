import type { RunFailure } from "./morning-run.ts";
import type { SandboxRunResult } from "./ports/index.ts";
import { READY_FOR_AGENT_LABEL } from "./ports/index.ts";

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
 * What a handed-back ticket is told about the morning that failed on it: what
 * went wrong, what the agent said, what became of its branch, and how to send
 * the ticket round again.
 *
 * Markdown, because that is what a ticket comment is read as — and so the
 * agent's own output is fenced, since anything it said unfenced would be read
 * as Markdown too.
 */
export function handbackComment(
  failure: RunFailure,
  run: SandboxRunResult | undefined,
  discard: Discard,
): string {
  const closing = `This ticket is yours again and will not be retried: add ${READY_FOR_AGENT_LABEL} back to send it round another morning.`;
  const reason = tail(failure.reason, REASON_QUOTED);

  if (failure.kind === "infrastructure") {
    return [
      `The morning loop could not carry this ticket through: the sandbox or the project checkout failed. It may never have started, or it may have stopped after the agent had already worked — the loop cannot tell which from here. Either way this is a setup to fix rather than a ticket to rewrite.`,
      `What went wrong: ${reason}`,
      ...branchNote(run, discard),
      closing,
    ].join("\n\n");
  }

  return [
    `The morning loop ran this ticket and the agent gave up.`,
    `Why it stopped: ${reason}`,
    `What it said:\n\n${quote(run?.output ?? "")}`,
    ...branchNote(run, discard),
    closing,
  ].join("\n\n");
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
