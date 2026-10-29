// The numbers the reader hands back, branded as `src/ports` brands the same figures. A mod does not
// import `src/`, so each brand is declared here with its own guard and constructor.

declare const processIdBrand: unique symbol
declare const tokenCountBrand: unique symbol
declare const reserveFractionBrand: unique symbol

/** The OS process carrying out one invocation: a whole number above 0. */
export type ProcessId = number & { readonly [processIdBrand]: true }

/** A number of tokens: a whole number, 0 or greater. */
export type TokenCount = number & { readonly [tokenCountBrand]: true }

/** The share of a window held back for the developer: at least 0 and less than 1. */
export type ReserveFraction = number & { readonly [reserveFractionBrand]: true }

export function isProcessId(value: number): value is ProcessId {
  return Number.isSafeInteger(value) && value > 0
}

export function isTokenCount(value: number): value is TokenCount {
  return Number.isSafeInteger(value) && value >= 0
}

export function isReserveFraction(value: number): value is ReserveFraction {
  return Number.isFinite(value) && value >= 0 && value < 1
}

/** Narrows `value` to a `TokenCount`; only for a literal known to be one. */
export function tokenCount(value: number): TokenCount {
  if (!isTokenCount(value)) throw new TypeError(`Not a token count: ${value}`)
  return value
}

/** Narrows `value` to a `ReserveFraction`; only for a literal known to be one. */
export function reserveFraction(value: number): ReserveFraction {
  if (!isReserveFraction(value)) throw new TypeError(`Not a reserve fraction: ${value}`)
  return value
}
