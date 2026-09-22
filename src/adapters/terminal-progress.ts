import type { Checkout } from "../ports/checkout.ts";
import type { Progress, ProgressEvent } from "../ports/progress.ts";
import type { StandDownReason } from "../ports/stand-down-reason.ts";
import { ticketKey } from "../ports/store.ts";
import type { TokenCount } from "../ports/token-count.ts";

/** How each stand-down reason reads to a person watching, rather than the token `StandDown.reason` carries. */
const REASON_PHRASES: Readonly<Record<StandDownReason, string>> = {
  "weekly-reserve": "the weekly reserve",
  "weekly-reserve-estimate": "the weekly reserve",
  "five-hour-window": "the 5-hour window",
  "five-hour-window-estimate": "the 5-hour window",
};

/** One run this adapter has announced starting but has not yet announced ending. */
interface Running {
  repo: string;
  number: number;
  checkout: Checkout;
}

/**
 * Writes each event as one plain line to stderr — appended, never redrawn,
 * so `trigger.log` and cron mail stay readable, and `stdout` stays free for
 * `report.message`, which is what piping the summary reads.
 *
 * Remembers every container it has announced starting until the matching run
 * ends, so a developer's second interrupt — which kills everything outright
 * rather than letting it finish, per `CONTEXT.md`'s "Stand down" — can be
 * told what it is about to abandon, container and clone both, by ticket.
 */
export function terminalProgress(): Progress {
  const running = new Map<string, Running>();

  return {
    note(event: ProgressEvent): void {
      switch (event.kind) {
        case "iteration-selected":
          line(`Working ${event.ticket.repo} #${event.ticket.number}.`);
          return;
        case "stood-down":
          line(
            `Stood down on ${event.ticket.repo} #${event.ticket.number}: ${reasonPhrase(event.reason)} ` +
              `(${tokens(event.tokensUsed)} of ${tokens(event.spendable)} tokens spendable, ` +
              `${tokens(event.estimateCharged)} charged as the run estimate). ` +
              `Resets ${event.resetsAt.toISOString()}.`,
          );
          return;
        case "container-started":
          running.set(ticketKey(event.ticket), {
            repo: event.ticket.repo,
            number: event.ticket.number,
            checkout: event.checkout,
          });
          line(
            `Starting a container for ${event.ticket.repo} #${event.ticket.number}, held to $${event.spendCeiling}.`,
          );
          return;
        case "run-ended":
          running.delete(ticketKey(event.ticket));
          line(
            `${event.ticket.repo} #${event.ticket.number} spent ${tokens(event.tokensUsed)} tokens.`,
          );
          return;
        case "provider-limited":
          line(
            `Stood down on ${event.ticket.repo} #${event.ticket.number}: the provider refused to run any more — ${event.limitRefusal}`,
          );
          return;
        case "abandoning":
          line(abandoningLine([...running.values()]));
          return;
        case "journal-unreadable":
          line(
            `The journal could not be read, so nothing is freed this invocation: ${event.error}`,
          );
          return;
      }
    },
  };
}

function line(text: string): void {
  console.error(text);
}

function reasonPhrase(reason: StandDownReason): string {
  return REASON_PHRASES[reason];
}

function tokens(count: TokenCount): string {
  return count.toLocaleString("en-US");
}

function abandoningLine(running: Running[]): string {
  if (running.length === 0) {
    return "Stopping now: nothing was left running.";
  }
  const named = running
    .map((run) => `${run.repo} #${run.number} (${run.checkout})`)
    .join(", ");
  return `Stopping now: abandoning ${named} — their containers and clones are left behind.`;
}
