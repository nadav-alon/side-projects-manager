import type { Grilling } from "../ports/index.ts";

/**
 * The interactive session, not started. The fake records the checkout it was
 * handed so a test can assert the command got that far and stopped there,
 * which is as much of an interactive step as a test may assert.
 */
export class FakeGrilling implements Grilling {
  /** The checkouts a session was started in, in order. */
  readonly started: string[] = [];

  async start(directory: string): Promise<void> {
    this.started.push(directory);
  }
}
