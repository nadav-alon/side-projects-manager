import type { Sandbox, SandboxRunResult, Ticket } from "../ports/index.ts";
import { tokenCount } from "../ports/index.ts";

/**
 * A sandbox that runs nothing and reports a successful, empty run.
 *
 * Tests that care whether the loop ran an agent at all spy on `run` with
 * `t.mock.method`; the fake does not record calls itself.
 */
export class FakeSandbox implements Sandbox {
  async run(ticket: Ticket): Promise<SandboxRunResult> {
    return {
      branch: `fake/${ticket.repo}/${ticket.number}`,
      commits: [],
      output: "",
      tokensUsed: tokenCount(0),
    };
  }
}
