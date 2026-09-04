import type {
  IssueTracker,
  Sandbox,
  SandboxRunResult,
  Store,
  Ticket,
  UsageLedger,
  UsageWindows,
} from "../ports/index.ts";

/**
 * Stand-ins wired into `morning-run` until the real adapters land. Each does
 * the least a caller can be asked to handle: nothing registered, nothing
 * eligible, nothing spent.
 */

/** TODO[#3]: replace with the registry and state documents. */
export const stubStore: Store = {
  loadProjects: async () => [],
};

/** TODO[#4]: replace with the `gh`-backed tracker. */
export const stubIssueTracker: IssueTracker = {
  listEligibleTickets: async (): Promise<Ticket[]> => [],
};

/** TODO[#5]: replace with the session-log parser. */
export const stubUsageLedger: UsageLedger = {
  read: async (now: Date): Promise<UsageWindows> => ({
    fiveHour: { openedAt: now, resetsAt: now, tokensUsed: 0 },
    weekly: { openedAt: now, resetsAt: now, tokensUsed: 0 },
  }),
};

/** TODO[#7]: replace with the sandcastle-backed sandbox. */
export const stubSandbox: Sandbox = {
  run: async (): Promise<SandboxRunResult> => {
    throw new Error("The sandbox is not wired up yet (see #7).");
  },
};
