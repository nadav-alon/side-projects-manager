import type { InvocationLease } from "../trigger-guard.ts";

/** An in-memory lease, held or free for the life of the fake. */
export class FakeInvocationLease implements InvocationLease {
  #held = false;

  async acquire(): Promise<boolean> {
    if (this.#held) {
      return false;
    }
    this.#held = true;
    return true;
  }

  async release(): Promise<void> {
    this.#held = false;
  }
}
