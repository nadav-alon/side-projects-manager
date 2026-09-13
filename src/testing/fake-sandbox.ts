import type {
  ModelName,
  ReviewRequest,
  ReviewRunResult,
  ReviewTicket,
  RunRequest,
  Sandbox,
  SandboxRunResult,
  Ticket,
} from "../ports/index.ts";
import { branch, tokenCount } from "../ports/index.ts";

/** What the agent CLI says, and all it says, once the provider limit refuses a run. */
export const LIMIT_REFUSAL = "You've hit your session limit · resets 1pm (UTC)";

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

  /**
   * A model name every run or review asked for comes back refused for,
   * unset to refuse none. Set to exercise a model refusal; `runs` and
   * `reviews` say which model each was asked for.
   */
  refusedModel: ModelName | undefined = undefined;

  async run(request: RunRequest): Promise<SandboxRunResult> {
    this.runs.push(request);
    if (request.model !== undefined && request.model === this.refusedModel) {
      return {
        branch: branch(`fake/${request.ticket.repo}/${request.ticket.number}`),
        commits: [],
        output: `refused model ${request.model}`,
        tokensUsed: tokenCount(0),
        modelRefusal: {
          model: request.model,
          words: `refused model ${request.model}`,
        },
      };
    }
    return this.result(request.ticket);
  }

  async review(request: ReviewRequest): Promise<ReviewRunResult> {
    this.reviews.push(request);
    if (request.model !== undefined && request.model === this.refusedModel) {
      return {
        output: `refused model ${request.model}`,
        tokensUsed: tokenCount(0),
        modelRefusal: {
          model: request.model,
          words: `refused model ${request.model}`,
        },
      };
    }
    return this.reviewResult(request.ticket);
  }
}
