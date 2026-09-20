import type { Progress, ProgressEvent } from "../ports/progress.ts";

/** How each stand-down reason reads to a person watching, rather than the token `StandDown.reason` carries. */
const REASON_PHRASES: Readonly<Record<string, string>> = {
  "weekly-reserve": "the weekly reserve",
  "weekly-reserve-estimate": "the weekly reserve",
  "five-hour-window": "the 5-hour window",
  "five-hour-window-estimate": "the 5-hour window",
};

/** One run this adapter has announced starting but has not yet announced ending. */
interface Running {
  repo: string;
  number: number;
}

/** Keys a ticket's run, so a `container-started` and its `run-ended` can be paired up. */
function key(repo: string, ticket: { number: number }): string {
  return `${repo}#${ticket.number}`;
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
          line(`Working ${event.repo} #${event.ticket.number}.`);
          return;
        case "stood-down":
          line(
            `Stood down on ${event.repo} #${event.ticket.number}: ${reasonPhrase(event.reason)} ` +
              `(${tokens(event.tokensUsed)} of ${tokens(event.spendable)} tokens spendable, ` +
              `${tokens(event.estimateCharged)} charged as the run estimate). ` +
              `Resets ${event.resetsAt.toISOString()}.`,
          );
          return;
        case "container-started":
          running.set(key(event.repo, event.ticket), {
            repo: event.repo,
            number: event.ticket.number,
          });
          line(
            `Starting a container for ${event.repo} #${event.ticket.number}, held to $${event.spendCeiling}.`,
          );
          return;
        case "run-ended":
          running.delete(key(event.repo, event.ticket));
          line(
            `${event.repo} #${event.ticket.number} spent ${tokens(event.tokensUsed)} tokens.`,
          );
          return;
        case "abandoning":
          line(abandoningLine([...running.values()]));
          return;
      }
    },
  };
}

function line(text: string): void {
  console.error(text);
}

function reasonPhrase(reason: string): string {
  return REASON_PHRASES[reason] ?? reason;
}

function tokens(count: number): string {
  return count.toLocaleString("en-US");
}

function abandoningLine(running: Running[]): string {
  if (running.length === 0) {
    return "Stopping now: nothing was left running.";
  }
  const named = running.map((run) => `${run.repo} #${run.number}`).join(", ");
  return `Stopping now: abandoning ${named} — their containers and clones are left behind.`;
}
