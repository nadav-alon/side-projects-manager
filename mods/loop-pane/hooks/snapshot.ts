import type { LoopSnapshot } from '../types'
import { managerHomeReader, type HomeFs } from './manager-home/reader'

/** The manager home: the plugin sits at `<home>/mods/<name>`, so the home is two levels up. */
export function managerHome(pluginRoot: string): string {
  return pluginRoot.replace(/\/+$/, '').split('/').slice(0, -2).join('/')
}

/** What the manager home shows at `now`; a missing or unreadable home is an empty snapshot, not an error. */
export async function readSnapshot(fs: HomeFs, home: string, now: Date): Promise<LoopSnapshot> {
  const reader = managerHomeReader(fs, home)
  const [invocation, usage] = await Promise.all([reader.inFlightInvocation(), reader.fiveHourUsage(now)])
  return {
    inFlight:
      invocation === undefined
        ? null
        : { openedAt: invocation.openedAt.toISOString(), runs: invocation.runs, freed: invocation.freed },
    usage: usage === undefined ? null : { tokensUsed: usage.tokensUsed, allowance: usage.allowance },
  }
}
