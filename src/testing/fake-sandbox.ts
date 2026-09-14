import type {
  ModelName,
  ModelRefusal,
  ReviewRequest,
  ReviewRunResult,
  ReviewTicket,
  RunRequest,
  Sandbox,
  SandboxRunResult,
  Ticket,
} from "../ports/index.ts";
import { branch, ticketKey, tokenCount } from "../ports/index.ts";
import { gate } from "./gate.ts";

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

  /** The most runs and reviews that were in progress at once. */
  mostInProgress = 0;

  #running = 0;
  #holding = false;
  /** Held runs and reviews, in the order they started, with what releases each. */
  readonly #held: { ticket: Ticket; release: () => void }[] = [];
  /** The one `whenHeld` still pending, if any. */
  #waiter: { count: number; resolve: () => void } | undefined;

  /**
   * Holds every run and review from now on until `release` names its ticket,
   * so a test can see several in progress at once and finish them in any
   * order it likes.
   */
  hold(): void {
    this.#holding = true;
  }

  /** The tickets whose runs or reviews are held, in the order they started. */
  held(): Ticket[] {
    return this.#held.map((entry) => entry.ticket);
  }

  /** Lets the held run or review on `ticket` finish. Throws if none is held. */
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

  /** Settles once at least `count` runs or reviews are held. Throws while another is pending. */
  whenHeld(count: number): Promise<void> {
    if (this.#waiter !== undefined) {
      throw new Error("already waiting on held runs");
    }
    return new Promise((resolve) => {
      this.#waiter = { count, resolve };
      this.#wakeWaiter();
    });
  }

  async run(request: RunRequest): Promise<SandboxRunResult> {
    this.runs.push(request);
    return this.#inProgress(request.ticket, () => {
      const modelRefusal = this.refusal(request);
      if (modelRefusal !== undefined) {
        return {
          branch: branch(`fake/${request.ticket.repo}/${request.ticket.number}`),
          commits: [],
          output: modelRefusal.words,
          tokensUsed: tokenCount(0),
          modelRefusal,
        };
      }
      return this.result(request.ticket);
    });
  }

  async review(request: ReviewRequest): Promise<ReviewRunResult> {
    this.reviews.push(request);
    return this.#inProgress(request.ticket, () => {
      const modelRefusal = this.refusal(request);
      if (modelRefusal !== undefined) {
        return {
          output: modelRefusal.words,
          tokensUsed: tokenCount(0),
          modelRefusal,
        };
      }
      return this.reviewResult(request.ticket);
    });
  }

  /** Counts `ticket`'s run or review as in progress until `finish`, holding it first if told to. */
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

  /** The refusal `refusedModel` calls for, absent for any other model or none. */
  private refusal({
    model,
  }: RunRequest | ReviewRequest): ModelRefusal | undefined {
    return model !== undefined && model === this.refusedModel
      ? { model, words: `refused model ${model}` }
      : undefined;
  }
}
