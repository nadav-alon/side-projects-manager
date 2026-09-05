import type { Grilling, GrillingSubject } from "../ports/index.ts";

/**
 * The interactive session, not started. The fake records what it was asked to
 * open a session about, so a test can assert the command got that far and
 * stopped there, which is as much of an interactive step as a test may assert.
 */
export class FakeGrilling implements Grilling {
  /** The subjects a session was started for, in order. */
  readonly started: GrillingSubject[] = [];

  async start(subject: GrillingSubject): Promise<void> {
    this.started.push(subject);
  }
}
