const UNITS = [
  { at: 1e12, suffix: 'T' },
  { at: 1e9, suffix: 'B' },
  { at: 1e6, suffix: 'M' },
  { at: 1e3, suffix: 'K' },
] as const

/** A count in compact units to one decimal (`2.1M`); below a thousand it is written whole. */
export function compactCount(count: number): string {
  const unit = UNITS.find(({ at }) => count >= at)
  return unit === undefined ? String(count) : `${(count / unit.at).toFixed(1)}${unit.suffix}`
}

/** `part` as a percentage of `whole`, with enough places that a small share does not read as zero; `0%` for an empty whole. */
export function percentOf(part: number, whole: number): string {
  if (whole <= 0) return '0%'
  const percent = (part / whole) * 100
  return `${percent >= 10 || percent === 0 ? percent.toFixed(0) : percent >= 1 ? percent.toFixed(1) : percent.toFixed(2)}%`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** The wall-clock time of `at` in the local zone, as `19:30`. */
export function localTime(at: Date): string {
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** A span in whole minutes, as `12m` or `1h 05m`; never negative. */
export function elapsed(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`
}
