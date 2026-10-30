import type { FiveHourUsage } from './manager-home/reader'

/** The share of the allowance the window has used, as a whole percent; it may pass 100. */
export function usedPercent({ tokensUsed, allowance }: FiveHourUsage): number {
  return Math.round((tokensUsed / allowance) * 100)
}

/** The band's one row: `5h window: <used>% used`. */
export function bandLabel(usage: FiveHourUsage): string {
  return `5h window: ${usedPercent(usage)}% used`
}
