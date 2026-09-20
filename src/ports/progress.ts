import type { Ticket } from "./issue-tracker.ts";
import type { RepoSlug } from "./repo-slug.ts";
import type { TokenCount } from "./token-count.ts";
import type { Usd } from "./usd.ts";

/**
 * One project's ticket, chosen to work this iteration. Announced before the
 * sandbox is ever invoked — the earliest point an iteration has anything to
 * say about itself.
 */
export interface IterationSelected {
  kind: "iteration-selected";
  repo: RepoSlug;
  ticket: Ticket;
}

/**
 * The gate refused the ticket about to start: the same facts `StandDown`
 * (`budget-gate.ts`) carries, so a caller already holding one has this for
 * free. Announced the instant the gate decides, rather than only surfacing
 * once the invocation report is written — a stand-down that is the last
 * thing said is exactly the silence this port exists to fix.
 */
export interface StoodDown {
  kind: "stood-down";
  repo: RepoSlug;
  ticket: Ticket;
  reason: string;
  tokensUsed: TokenCount;
  spendable: TokenCount;
  resetsAt: Date;
  estimateCharged: TokenCount;
}

/** A container is starting `ticket`'s run, held to `spendCeiling`. */
export interface ContainerStarted {
  kind: "container-started";
  repo: RepoSlug;
  ticket: Ticket;
  spendCeiling: Usd;
}

/**
 * A run in the container ended, having spent `tokensUsed` — whatever it came
 * to, not only a run that finished cleanly.
 */
export interface RunEnded {
  kind: "run-ended";
  repo: RepoSlug;
  ticket: Ticket;
  tokensUsed: TokenCount;
}

/**
 * The developer's second interrupt: whatever is still running is about to be
 * killed outright rather than left to finish, its container and clone left
 * behind rather than cleaned up. Carries nothing of its own — an adapter
 * that wants to name what is being abandoned has already been told, by the
 * `container-started` and `run-ended` events that came before it.
 */
export interface Abandoning {
  kind: "abandoning";
}

/** Something worth telling whoever is watching an invocation, the instant it happens. */
export type ProgressEvent =
  | IterationSelected
  | StoodDown
  | ContainerStarted
  | RunEnded
  | Abandoning;

/**
 * Reports something that just happened. Nothing here is ever read back — the
 * loop's whole account of itself afterwards is the invocation report; this
 * is only for the minutes in between, so a healthy morning never reads, from
 * outside, as a wedged process.
 *
 * The loop learns that it narrates; it never learns what a terminal is. See
 * the terminal adapter for the one that writes lines, and the no-op adapter,
 * the default, for anything that has nowhere to put one.
 */
export interface Progress {
  note(event: ProgressEvent): void;
}

/**
 * Calls `progress.note(event)`, swallowing whatever it throws. A progress
 * write is for whoever is watching; a broken terminal or a full pipe must
 * never be what fails an invocation that still has runs to finish, or change
 * the exit code it reports.
 */
export function notify(progress: Progress, event: ProgressEvent): void {
  try {
    progress.note(event);
  } catch {
    // Never the invocation's problem — see this function's own doc comment.
  }
}
