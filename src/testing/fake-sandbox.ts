import type { Sandbox, SandboxRunResult, Ticket } from "../ports/index.ts";

/**
 * Records every ticket it was asked to run. Tests assert on `runs` —
 * including asserting it stayed empty, which is how "the loop did no work"
 * is checked.
 */
export class FakeSandbox implements Sandbox {
  readonly runs: Ticket[] = [];

  async run(ticket: Ticket): Promise<SandboxRunResult> {
    this.runs.push(ticket);
    return {
      branch: `fake/${ticket.repo}/${ticket.number}`,
      commits: [],
      output: "",
      tokensUsed: 0,
    };
  }
}
