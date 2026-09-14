import type {
  ModelName,
  ReviewModelRefused,
  ReviewOutcome,
  ReviewRequest,
  ReviewTicket,
  RunModelRefused,
  RunOutcome,
  RunRequest,
  Sandbox,
  Ticket,
} from "../ports/index.ts";
import { branch, tokenCount } from "../ports/index.ts";

/**
 * A sandbox that runs nothing and reports a successful, empty run.
 *
 * Tests arrange what a run or a review comes to through `result` and
 * `reviewResult`, and inspect `runs` and `reviews` to see which tickets the
 * loop ran and against which checkouts. Whatever those return is what comes
 * back, verbatim: this fake detects no refusal and words none of its own, so
 * a test after a limit refusal or a model refusal writes the exact variant it
 * wants.
 */
export class FakeSandbox implements Sandbox {
  /** Every run asked for, in order. */
  readonly runs: RunRequest[] = [];

  /** Every review asked for, in order. */
  readonly reviews: ReviewRequest[] = [];

  /** What the next run comes to. An empty, costless, finished run unless set. */
  result: (ticket: Ticket) => RunOutcome = (ticket) => ({
    kind: "finished",
    branch: branch(`fake/${ticket.repo}/${ticket.number}`),
    commits: [],
    output: "",
    tokensUsed: tokenCount(0),
  });

  /** What the next review comes to. A costless, finished review unless set. */
  reviewResult: (ticket: ReviewTicket) => ReviewOutcome = () => ({
    kind: "finished",
    output: "",
    tokensUsed: tokenCount(0),
  });

  run(request: RunRequest & { model: ModelName }): Promise<RunOutcome>;
  run(
    request: RunRequest & { model?: undefined },
  ): Promise<Exclude<RunOutcome, RunModelRefused>>;
  async run(request: RunRequest): Promise<RunOutcome> {
    this.runs.push(request);
    return this.result(request.ticket);
  }

  review(request: ReviewRequest & { model: ModelName }): Promise<ReviewOutcome>;
  review(
    request: ReviewRequest & { model?: undefined },
  ): Promise<Exclude<ReviewOutcome, ReviewModelRefused>>;
  async review(request: ReviewRequest): Promise<ReviewOutcome> {
    this.reviews.push(request);
    return this.reviewResult(request.ticket);
  }
}
