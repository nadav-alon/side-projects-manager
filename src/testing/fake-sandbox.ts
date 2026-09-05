import type { Sandbox, SandboxRunResult, Ticket } from "../ports/index.ts";
import { tokenCount } from "../ports/index.ts";

/** One run the loop asked for, in the order the fake received it. */
export interface FakeRun {
  ticket: Ticket;
  /** The project checkout the loop handed over to run against. */
  checkout: string;
}

/**
 * A sandbox that runs nothing and reports a successful, empty run.
 *
 * Tests arrange what a run comes back with through `result`, and inspect
 * `runs` to see which tickets the loop ran and against which checkouts.
 */
export class FakeSandbox implements Sandbox {
  /** Every run asked for, in order. */
  readonly runs: FakeRun[] = [];

  /** What the next run comes to. An empty, costless run unless set. */
  result: (ticket: Ticket) => SandboxRunResult = (ticket) => ({
    branch: `fake/${ticket.repo}/${ticket.number}`,
    commits: [],
    output: "",
    tokensUsed: tokenCount(0),
  });

  async run(ticket: Ticket, checkout: string): Promise<SandboxRunResult> {
    this.runs.push({ ticket, checkout });
    return this.result(ticket);
  }
}
