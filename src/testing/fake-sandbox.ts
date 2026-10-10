import path from "node:path";

import type {
  ApplyReviewOutcome,
  ApplyReviewRequest,
  ApplyReviewTicket,
  Checkout,
  ModelName,
  OnRunStarted,
  RebaseOutcome,
  RebaseRequest,
  RebaseTicket,
  ReviewModelRefused,
  ReviewOutcome,
  ReviewRequest,
  ReviewTicket,
  RunModelRefused,
  RunOutcome,
  RunProgress,
  RunRequest,
  Sandbox,
  SpecReviewOutcome,
  SpecReviewRequest,
  SpecReviewTicket,
  UxReviewOutcome,
  UxReviewRequest,
  UxReviewTicket,
  Ticket,
} from "../ports/index.ts";
import { branch, ticketKey, tokenCount, transcriptDirectory } from "../ports/index.ts";
import { imageTag, type ImageTag } from "../ports/image-tag.ts";
import { gate } from "./gate.ts";

/** The image the fake's `prepare` hands back unless a test says otherwise. */
export const FAKE_IMAGE = imageTag("side-projects-sandbox:fake");

/** A `TranscriptDirectory` deterministic in `ticket`, for a fake run's own `onStarted` to report. */
function fakeTranscriptDirectory(ticket: Ticket) {
  return transcriptDirectory(path.join("/fake-transcripts", ticketKey(ticket)));
}

/**
 * A sandbox that runs nothing and reports a successful, empty run.
 *
 * Tests arrange what a run, a review, an apply-review run, a rebase run or a
 * spec review run comes to through `result`, `reviewResult`,
 * `applyReviewResult`, `rebaseResult` and `specReviewResult`, and inspect
 * `runs`, `reviews`, `applyReviews`, `rebases` and `specReviews` to see which
 * tickets the loop ran and against which checkouts. Whatever
 * those return is what comes back, verbatim: this fake detects no refusal and
 * words none of its own, so a test after a limit refusal or a model refusal
 * writes the exact variant it wants.
 */
export class FakeSandbox implements Sandbox {
  /** Every checkout whose image was asked to be prepared, in order. */
  readonly prepared: Checkout[] = [];

  /** What preparing a project's image comes to: a rejection arranges a refused build. Resolves to `FAKE_IMAGE` unless set. */
  prepareResult: (checkout: Checkout) => Promise<ImageTag> = () => Promise.resolve(FAKE_IMAGE);

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

  /**
   * The progress a run reports to its request's `onProgress`, in order, once
   * it is in progress and before any hold — so a caller sees it while the run
   * is still going. None unless set.
   */
  progress: (ticket: Ticket) => RunProgress[] = () => [];

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

  /** Every rebase run asked for, in order. */
  readonly rebases: RebaseRequest[] = [];

  /** What the next rebase run comes to. A costless, finished one unless set. */
  rebaseResult: (ticket: RebaseTicket) => RebaseOutcome = () => ({
    kind: "finished",
    output: "",
    tokensUsed: tokenCount(0),
  });

  /** Every spec review run asked for, in order. */
  readonly specReviews: SpecReviewRequest[] = [];

  /** What the next spec review run comes to. A costless, finished one unless set. */
  specReviewResult: (ticket: SpecReviewTicket) => SpecReviewOutcome = () => ({
    kind: "finished",
    output: "",
    tokensUsed: tokenCount(0),
  });

  /** Every ux review run asked for, in order. */
  readonly uxReviews: UxReviewRequest[] = [];

  /** What the next ux review run comes to. A costless, finished one unless set. */
  uxReviewResult: (ticket: UxReviewTicket) => UxReviewOutcome = () => ({
    kind: "finished",
    output: "",
    tokensUsed: tokenCount(0),
  });

  /** The most runs, reviews, apply-review runs and rebase runs that were in progress at once. */
  mostInProgress = 0;

  #running = 0;
  #holding = false;
  /** Held runs, reviews, apply-review runs and rebase runs, in the order they started, with what releases each. */
  readonly #held: { ticket: Ticket; release: () => void }[] = [];
  /** The one `whenHeld` still pending, if any. */
  #waiter: { count: number; resolve: () => void } | undefined;

  /**
   * Holds every run, review, apply-review run and rebase run from now on
   * until `release` names its ticket, so a test can see several in progress
   * at once and finish them in any order it likes.
   */
  hold(): void {
    this.#holding = true;
  }

  /** The tickets whose runs, reviews, apply-review runs or rebase runs are held, in the order they started. */
  held(): Ticket[] {
    return this.#held.map((entry) => entry.ticket);
  }

  /** Lets the held run, review, apply-review run or rebase run on `ticket` finish. Throws if none is held. */
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

  /** Settles once at least `count` runs, reviews, apply-review runs or rebase runs are held. Throws while another is pending. */
  whenHeld(count: number): Promise<void> {
    if (this.#waiter !== undefined) {
      throw new Error("already waiting on held runs");
    }
    return new Promise((resolve) => {
      this.#waiter = { count, resolve };
      this.#wakeWaiter();
    });
  }

  prepare(checkout: Checkout): Promise<ImageTag> {
    this.prepared.push(checkout);
    return this.prepareResult(checkout);
  }

  run(
    request: RunRequest & { model: ModelName },
    onStarted?: OnRunStarted,
  ): Promise<RunOutcome>;
  run(
    request: RunRequest & { model?: undefined },
    onStarted?: OnRunStarted,
  ): Promise<Exclude<RunOutcome, RunModelRefused>>;
  async run(
    request: RunRequest,
    onStarted?: OnRunStarted,
  ): Promise<RunOutcome> {
    this.runs.push(request);
    return this.#inProgress(
      request.ticket,
      onStarted,
      () => this.result(request.ticket),
      () => {
        for (const progress of this.progress(request.ticket)) {
          request.onProgress?.(progress);
        }
      },
    );
  }

  review(
    request: ReviewRequest & { model: ModelName },
    onStarted?: OnRunStarted,
  ): Promise<ReviewOutcome>;
  review(
    request: ReviewRequest & { model?: undefined },
    onStarted?: OnRunStarted,
  ): Promise<Exclude<ReviewOutcome, ReviewModelRefused>>;
  async review(
    request: ReviewRequest,
    onStarted?: OnRunStarted,
  ): Promise<ReviewOutcome> {
    this.reviews.push(request);
    return this.#inProgress(request.ticket, onStarted, () =>
      this.reviewResult(request.ticket),
    );
  }

  applyReview(
    request: ApplyReviewRequest & { model: ModelName },
    onStarted?: OnRunStarted,
  ): Promise<ApplyReviewOutcome>;
  applyReview(
    request: ApplyReviewRequest & { model?: undefined },
    onStarted?: OnRunStarted,
  ): Promise<Exclude<ApplyReviewOutcome, ReviewModelRefused>>;
  async applyReview(
    request: ApplyReviewRequest,
    onStarted?: OnRunStarted,
  ): Promise<ApplyReviewOutcome> {
    this.applyReviews.push(request);
    return this.#inProgress(request.ticket, onStarted, () =>
      this.applyReviewResult(request.ticket),
    );
  }

  rebase(
    request: RebaseRequest & { model: ModelName },
    onStarted?: OnRunStarted,
  ): Promise<RebaseOutcome>;
  rebase(
    request: RebaseRequest & { model?: undefined },
    onStarted?: OnRunStarted,
  ): Promise<Exclude<RebaseOutcome, ReviewModelRefused>>;
  async rebase(
    request: RebaseRequest,
    onStarted?: OnRunStarted,
  ): Promise<RebaseOutcome> {
    this.rebases.push(request);
    return this.#inProgress(request.ticket, onStarted, () =>
      this.rebaseResult(request.ticket),
    );
  }

  specReview(
    request: SpecReviewRequest & { model: ModelName },
    onStarted?: OnRunStarted,
  ): Promise<SpecReviewOutcome>;
  specReview(
    request: SpecReviewRequest & { model?: undefined },
    onStarted?: OnRunStarted,
  ): Promise<Exclude<SpecReviewOutcome, ReviewModelRefused>>;
  async specReview(
    request: SpecReviewRequest,
    onStarted?: OnRunStarted,
  ): Promise<SpecReviewOutcome> {
    this.specReviews.push(request);
    return this.#inProgress(request.ticket, onStarted, () =>
      this.specReviewResult(request.ticket),
    );
  }

  uxReview(
    request: UxReviewRequest & { model: ModelName },
    onStarted?: OnRunStarted,
  ): Promise<UxReviewOutcome>;
  uxReview(
    request: UxReviewRequest & { model?: undefined },
    onStarted?: OnRunStarted,
  ): Promise<Exclude<UxReviewOutcome, ReviewModelRefused>>;
  async uxReview(
    request: UxReviewRequest,
    onStarted?: OnRunStarted,
  ): Promise<UxReviewOutcome> {
    this.uxReviews.push(request);
    return this.#inProgress(request.ticket, onStarted, () =>
      this.uxReviewResult(request.ticket),
    );
  }

  /**
   * Counts `ticket`'s run, review, apply-review run or rebase run as in
   * progress until `finish`, holding it first if told to. Calls `onStarted`,
   * when given, with a fake but deterministic transcript directory before
   * either — as `containerSandbox` calls it, before the run itself is even
   * held or finished. `whileRunning`, when given, runs once the run counts as
   * in progress and before it is held.
   */
  async #inProgress<T>(
    ticket: Ticket,
    onStarted: OnRunStarted | undefined,
    finish: () => T,
    whileRunning?: () => void,
  ): Promise<T> {
    onStarted?.({ transcriptDirectory: fakeTranscriptDirectory(ticket) });
    this.#running++;
    this.mostInProgress = Math.max(this.mostInProgress, this.#running);
    try {
      whileRunning?.();
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
