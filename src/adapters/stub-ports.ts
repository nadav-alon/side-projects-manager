import type { Sandbox, SandboxRunResult } from "../ports/index.ts";

/**
 * Stand-ins wired into `morning-run` until the real adapters land. Each does
 * the least a caller can be asked to handle: nothing eligible, nothing spent.
 */

/** TODO[#7]: replace with the sandcastle-backed sandbox. */
export const stubSandbox: Sandbox = {
  run: async (): Promise<SandboxRunResult> => {
    throw new Error("The sandbox is not wired up yet (see #7).");
  },
};
