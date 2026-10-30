import type { FiveHourUsage } from './manager-home/reader'

/** The share of the allowance the window has used, as a whole percent; it may pass 100. */
export function usedPercent({ tokensUsed, allowance }: FiveHourUsage): number {
  return Math.round((tokensUsed / allowance) * 100)
}

/** The band's one row: `5h window: <used>% used`. */
export function bandLabel(usage: FiveHourUsage): string {
  return `5h window: ${usedPercent(usage)}% used`
}

/** Whether the window's usage has reached the share of the allowance the loop keeps in reserve. */
export function isInReserve({ tokensUsed, allowance, reserveFraction }: FiveHourUsage): boolean {
  return tokensUsed >= allowance * (1 - reserveFraction)
}
