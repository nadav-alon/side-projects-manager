const NAME = /side[-_\s]*projects?[-_\s]*manager/i

/** The line of the text where a mention of the manager starts, or undefined when none does. */
export function lineNamingManager(text: string): string | undefined {
  const start = NAME.exec(text)?.index
  if (start === undefined) return undefined
  const from = text.lastIndexOf('\n', start - 1) + 1
  const end = text.indexOf('\n', start)
  return text.slice(from, end === -1 ? undefined : end).trim()
}
