import type {
  Sandbox,
  SandboxRunResult,
  UsageLedger,
  UsageWindows,
} from "../ports/index.ts";
import { tokenCount } from "../ports/index.ts";

/**
 * Stand-ins wired into `morning-run` until the real adapters land. Each does
 * the least a caller can be asked to handle: nothing eligible, nothing spent.
 */

/** TODO[#5]: replace with the session-log parser. */
export const stubUsageLedger: UsageLedger = {
  read: async (now: Date): Promise<UsageWindows> => ({
    fiveHour: { openedAt: now, resetsAt: now, tokensUsed: tokenCount(0) },
    weekly: { openedAt: now, resetsAt: now, tokensUsed: tokenCount(0) },
  }),
};

/** TODO[#7]: replace with the sandcastle-backed sandbox. */
export const stubSandbox: Sandbox = {
  run: async (): Promise<SandboxRunResult> => {
    throw new Error("The sandbox is not wired up yet (see #7).");
  },
};
