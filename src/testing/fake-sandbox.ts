import type {
  ApplyReviewOutcome,
  ApplyReviewRequest,
  ApplyReviewTicket,
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
import { branch, ticketKey, tokenCount } from "../ports/index.ts";
import { gate } from "./gate.ts";

/**
 * A sandbox that runs nothing and reports a successful, empty run.
 *
 * Tests arrange what a run, a review or an apply-review run comes to through
 * `result`, `reviewResult` and `applyReviewResult`, and inspect `runs`,
 * `reviews` and `applyReviews` to see which tickets the loop ran and against
 * which checkouts. Whatever those return is what comes
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

  /** Every apply-review run asked for, in order. */
  readonly applyReviews: ApplyReviewRequest[] = [];

  /** What the next apply-review run comes to. A costless, finished one unless set. */
  applyReviewResult: (ticket: ApplyReviewTicket) => ApplyReviewOutcome = () => ({
    kind: "finished",
    output: "",
    tokensUsed: tokenCount(0),
  });

  /** The most runs, reviews and apply-review runs that were in progress at once. */
  mostInProgress = 0;

  #running = 0;
  #holding = false;
  /** Held runs, reviews and apply-review runs, in the order they started, with what releases each. */
  readonly #held: { ticket: Ticket; release: () => void }[] = [];
  /** The one `whenHeld` still pending, if any. */
  #waiter: { count: number; resolve: () => void } | undefined;

  /**
   * Holds every run, review and apply-review run from now on until `release` names its ticket,
   * so a test can see several in progress at once and finish them in any
   * order it likes.
   */
  hold(): void {
    this.#holding = true;
  }

  /** The tickets whose runs, reviews or apply-review runs are held, in the order they started. */
  held(): Ticket[] {
    return this.#held.map((entry) => entry.ticket);
  }

  /** Lets the held run, review or apply-review run on `ticket` finish. Throws if none is held. */
  release(ticket: Ticket): void {
    const index = this.#held.findIndex(
      (entry) => ticketKey(entry.ticket) === ticketKey(ticket),
    );
    const [entry] = index === -1 ? [] : this.#held.splice(index, 1);
    if (entry === undefined) {
      throw new Error(`no run held on ${ticket.repo} #${ticket.number}`);
    }
    entry.release();
  }

  /** Settles once at least `count` runs, reviews or apply-review runs are held. Throws while another is pending. */
  whenHeld(count: number): Promise<void> {
    if (this.#waiter !== undefined) {
      throw new Error("already waiting on held runs");
    }
    return new Promise((resolve) => {
      this.#waiter = { count, resolve };
      this.#wakeWaiter();
    });
  }

  run(request: RunRequest & { model: ModelName }): Promise<RunOutcome>;
  run(
    request: RunRequest & { model?: undefined },
  ): Promise<Exclude<RunOutcome, RunModelRefused>>;
  async run(request: RunRequest): Promise<RunOutcome> {
    this.runs.push(request);
    return this.#inProgress(request.ticket, () => this.result(request.ticket));
  }

  review(request: ReviewRequest & { model: ModelName }): Promise<ReviewOutcome>;
  review(
    request: ReviewRequest & { model?: undefined },
  ): Promise<Exclude<ReviewOutcome, ReviewModelRefused>>;
  async review(request: ReviewRequest): Promise<ReviewOutcome> {
    this.reviews.push(request);
    return this.#inProgress(request.ticket, () =>
      this.reviewResult(request.ticket),
    );
  }

  applyReview(
    request: ApplyReviewRequest & { model: ModelName },
  ): Promise<ApplyReviewOutcome>;
  applyReview(
    request: ApplyReviewRequest & { model?: undefined },
  ): Promise<Exclude<ApplyReviewOutcome, ReviewModelRefused>>;
  async applyReview(request: ApplyReviewRequest): Promise<ApplyReviewOutcome> {
    this.applyReviews.push(request);
    return this.#inProgress(request.ticket, () =>
      this.applyReviewResult(request.ticket),
    );
  }

  /** Counts `ticket`'s run, review or apply-review run as in progress until `finish`, holding it first if told to. */
  async #inProgress<T>(ticket: Ticket, finish: () => T): Promise<T> {
    this.#running++;
    this.mostInProgress = Math.max(this.mostInProgress, this.#running);
    try {
      if (this.#holding) {
        const released = gate();
        this.#held.push({ ticket, release: released.open });
        this.#wakeWaiter();
        await released.opened;
      }
      return finish();
    } finally {
      this.#running--;
    }
  }

  #wakeWaiter(): void {
    const waiter = this.#waiter;
    if (waiter !== undefined && this.#held.length >= waiter.count) {
      this.#waiter = undefined;
      waiter.resolve();
    }
  }
}
