import type { Mode, ModeBand, Ticket } from '../types'

/** The mode each mode skill puts a session in. */
const modeOfSkill: Record<string, Mode> = {
  grilling: 'grill',
  'grill-me': 'grill',
  standup: 'standup',
  triage: 'triage',
  wayfinder: 'wayfinder',
}

/** The band's background per mode, the colours the status line's mode badge uses. */
export const colorOfMode: Record<Mode, string> = {
  grill: 'magenta',
  standup: 'cyan',
  triage: 'yellow',
  wayfinder: 'green',
}

const ticketPattern = /([\w.-]+\/[\w.-]+)#(\d+)/

/** The ticket a skill's prompt names as `owner/repo#n`, or null when it names none. */
export function ticketIn(text: string): Ticket | null {
  const found = ticketPattern.exec(text)
  if (found === null) return null
  return { repo: found[1]!, number: Number(found[2]) }
}

/** The mode band a skill invocation sets, or null when the skill is no mode skill. */
export function bandOfSkill(skill: string, text: string): ModeBand | null {
  const mode = modeOfSkill[skill]
  if (mode === undefined) return null
  return { mode, ticket: ticketIn(text) }
}

/** The band's one row: `<mode>: <owner/repo>#<n>`, just the mode when no ticket is named. */
export function bandLabel({ mode, ticket }: ModeBand): string {
  return ticket === null ? mode : `${mode}: ${ticket.repo}#${ticket.number}`
}
