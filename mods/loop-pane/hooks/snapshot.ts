import type { LoopSnapshot } from '../types'
import { tokenCount, type ProcessId, type ReserveFraction, type TokenCount } from './manager-home/types'
import { managerHomeReader, type HomeFs } from './manager-home/reader'

/** The manager home: the plugin sits at `<home>/mods/<name>`, so the home is two levels up. */
export function managerHome(pluginRoot: string): string {
  return pluginRoot.replace(/\/+$/, '').split('/').slice(0, -2).join('/')
}

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
): Promise<LoopSnapshot> {
  const reader = managerHomeReader(fs, home)
  const [invocation, usage] = await Promise.all([reader.inFlightInvocation(), reader.fiveHourUsage(now)])
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
  }
}
