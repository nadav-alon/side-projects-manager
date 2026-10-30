declare const ticketReferenceBrand: unique symbol

/** A ticket named as `owner/repo#n`, with `n` a positive integer written without leading zeros. */
export type TicketReference = string & { readonly [ticketReferenceBrand]: true }

const referencePattern = /^([\w.-]+\/[\w.-]+)#(\d+)$/

/** Reads `text` as a ticket reference, as `src/grant.ts`'s `parseTicketReference` does; `undefined` when it is not one. */
export function parseTicketReference(text: string): TicketReference | undefined {
  const match = referencePattern.exec(text.trim())
  const number = Number(match?.[2])
  if (match === null || !Number.isSafeInteger(number) || number < 1) return undefined
  return `${match[1]}#${number}` as TicketReference
}
