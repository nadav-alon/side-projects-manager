import type { Progress, ProgressEvent } from "../ports/progress.ts";

/** Records every event handed to it, in order, so a test can see what an invocation narrated and when. */
export class FakeProgress implements Progress {
  readonly events: ProgressEvent[] = [];

  note(event: ProgressEvent): void {
    this.events.push(event);
  }
}
