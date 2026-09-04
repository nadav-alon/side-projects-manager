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
 * Stand-ins wired into `morning-run` until the tickets that own the real
 * implementations land. Each does the least a caller can be asked to handle:
 * nothing registered, nothing ready, nothing spent. The loop's quiet-morning
 * path runs through them end to end.
 */

/** Replaced by the registry and state documents (#3). */
export const stubStore: Store = {
  loadProjects: async () => [],
};

/** Replaced by the `gh`-backed tracker (#4). */
export const stubIssueTracker: IssueTracker = {
  listReadyTickets: async (): Promise<Ticket[]> => [],
};

/** Replaced by the session-log parser (#5). */
export const stubUsageLedger: UsageLedger = {
  read: async (): Promise<UsageWindows> => ({ last5Hours: 0, last7Days: 0 }),
};

/** Replaced by the sandcastle-backed sandbox (#7). */
export const stubSandbox: Sandbox = {
  run: async (): Promise<SandboxRunResult> => {
    throw new Error("The sandbox is not wired up yet (see #7).");
  },
};
