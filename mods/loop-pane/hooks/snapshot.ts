import type { LoopSnapshot } from '../types/index.d.ts'
import { tokenCount, type ProcessId, type ReserveFraction, type TokenCount } from './manager-home/types.ts'
import { managerHomeReader, type HomeFs } from './manager-home/reader.ts'

/** The allowance less the reserve rounded up, as the gate's `spendableOf` computes it. */
function spendableOf(allowance: TokenCount, reserve: ReserveFraction): TokenCount {
  return tokenCount(allowance - Math.ceil(allowance * reserve))
}

/** What the manager home shows at `now`, `alive` saying whether a process still runs; a missing or unreadable home is an empty snapshot, not an error. */
export async function readSnapshot(
  fs: HomeFs,
  alive: (pid: ProcessId) => Promise<boolean>,
  home: string,
  now: Date,
  sessionLogs?: string,
): Promise<LoopSnapshot> {
  const reader = managerHomeReader(fs, home, sessionLogs)
  const [invocation, usage, recorded] = await Promise.all([reader.inFlightInvocation(), reader.fiveHourUsage(now), reader.recordedDiscoveries()])
  return {
    inFlight:
      invocation === undefined
        ? null
        : {
            openedAt: invocation.openedAt.toISOString(),
            pid: invocation.pid,
            alive: await alive(invocation.pid),
            runs: invocation.runs,
            freed: invocation.freed,
          },
    usage: usage === undefined ? null : { tokensUsed: usage.tokensUsed, spendable: spendableOf(usage.allowance, usage.reserveFraction) },
    discoveries: recorded === undefined ? null : recorded.map(({ repo, number, kind, title }) => ({ repo, number, kind, title })),
  }
}
