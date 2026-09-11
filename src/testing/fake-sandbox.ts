import type {
  ReviewRequest,
  ReviewRunResult,
  ReviewTicket,
  RunRequest,
  Sandbox,
  SandboxRunResult,
  Ticket,
} from "../ports/index.ts";
import { branch, tokenCount } from "../ports/index.ts";

/**
 * A sandbox that runs nothing and reports a successful, empty run.
 *
 * Tests arrange what a run comes back with through `result`, and inspect
 * `runs` to see which tickets the loop ran and against which checkouts.
 */
export class FakeSandbox implements Sandbox {
  /** Every run asked for, in order. */
  readonly runs: RunRequest[] = [];

  /** Every review asked for, in order. */
  readonly reviews: ReviewRequest[] = [];

  /** What the next run comes to. An empty, costless run unless set. */
  result: (ticket: Ticket) => SandboxRunResult = (ticket) => ({
    branch: branch(`fake/${ticket.repo}/${ticket.number}`),
    commits: [],
    output: "",
    tokensUsed: tokenCount(0),
  });

  /** What the next review comes to. A costless, posted review unless set. */
  reviewResult: (ticket: ReviewTicket) => ReviewRunResult = () => ({
    output: "",
    tokensUsed: tokenCount(0),
  });

  async run(request: RunRequest): Promise<SandboxRunResult> {
    this.runs.push(request);
    return this.result(request.ticket);
  }

  async review(request: ReviewRequest): Promise<ReviewRunResult> {
    this.reviews.push(request);
    return this.reviewResult(request.ticket);
  }
}
