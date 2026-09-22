import type { Checkout } from "./checkout.ts";
import type { Ticket } from "./issue-tracker.ts";
import type { StandDownReason } from "./stand-down-reason.ts";
import type { TokenCount } from "./token-count.ts";
import type { Usd } from "./usd.ts";

/**
 * One project's ticket, chosen to work this iteration. Announced before the
 * sandbox is ever invoked — the earliest point an iteration has anything to
 * say about itself.
 */
export interface IterationSelected {
  kind: "iteration-selected";
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
  ticket: Ticket;
  reason: StandDownReason;
  tokensUsed: TokenCount;
  spendable: TokenCount;
  resetsAt: Date;
  estimateCharged: TokenCount;
}

/**
 * A container is starting `ticket`'s run, held to `spendCeiling`, on the
 * throwaway `checkout` it runs against — the path an `abandoning` event
 * would otherwise have nowhere to name.
 */
export interface ContainerStarted {
  kind: "container-started";
  ticket: Ticket;
  spendCeiling: Usd;
  checkout: Checkout;
}

/**
 * A run in the container ended, having spent `tokensUsed` — whatever it came
 * to, not only a run that finished cleanly.
 */
export interface RunEnded {
  kind: "run-ended";
  ticket: Ticket;
  tokensUsed: TokenCount;
}

/**
 * The provider itself refused `ticket`'s run mid-invocation — a stand-down
 * the gate never saw coming, so it carries the provider's own words rather
 * than `stood-down`'s budget-window facts. Every run after this one would be
 * refused the same way, so nothing further starts; announced immediately
 * rather than left for the iterations already in progress to finish first.
 */
export interface ProviderLimited {
  kind: "provider-limited";
  ticket: Ticket;
  limitRefusal: string;
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

/**
 * The journal could not be read when checking for worked-today entries a
 * dead in-flight invocation recorded. Nothing is freed this invocation, but
 * it still runs and still stamps its own identity on what it records — see
 * CONTEXT.md's "Worked today".
 */
export interface JournalUnreadable {
  kind: "journal-unreadable";
  error: string;
}

/** Something worth telling whoever is watching an invocation, the instant it happens. */
export type ProgressEvent =
  | IterationSelected
  | StoodDown
  | ContainerStarted
  | RunEnded
  | ProviderLimited
  | Abandoning
  | JournalUnreadable;

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
