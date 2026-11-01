const UNITS = [
  { at: 1e12, suffix: 'T' },
  { at: 1e9, suffix: 'B' },
  { at: 1e6, suffix: 'M' },
  { at: 1e3, suffix: 'K' },
] as const

/** A count in compact units to one decimal (`2.1M`); below a thousand it is written whole. A figure that rounds up to 1000 of a unit is written in the next one up (`1.0M`, not `1000.0K`). */
export function compactCount(count: number): string {
  const index = UNITS.findIndex(({ at }) => count >= at)
  if (index === -1) return String(count)
  const rounds = (i: number) => Number((count / UNITS[i]!.at).toFixed(1))
  const stepUp = index > 0 && rounds(index) >= 1000
  const unit = UNITS[stepUp ? index - 1 : index]!
  return `${(count / unit.at).toFixed(1)}${unit.suffix}`
}

/** The decimal places a percentage is written with, so a small share does not read as zero. */
function places(percent: number): number {
  if (percent === 0 || percent >= 10) return 0
  if (percent >= 1) return 1
  return 2
}

/** `part` as a percentage of `whole`, with enough places that a small share does not read as zero; `0%` for an empty whole. */
export function percentOf(part: number, whole: number): string {
  if (whole <= 0) return '0%'
  const percent = (part / whole) * 100
  return `${percent.toFixed(places(percent))}%`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** The wall-clock time of `at` in the local zone, as `19:30`. */
export function localTime(at: Date): string {
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** The span from `from` to `to` in whole minutes, as `12m` or `1h 05m`; never negative. */
export function elapsed(from: Date, to: Date): string {
  const minutes = Math.max(0, Math.floor((to.getTime() - from.getTime()) / 60_000))
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`
}
