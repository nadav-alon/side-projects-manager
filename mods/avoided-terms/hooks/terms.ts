/** A term the glossary tells writers to avoid, and the glossary term to write instead. */
export interface AvoidedTerm {
  avoided: string
  preferred: string
}

/**
 * The avoided terms a CONTEXT.md glossary lists, each with the entry it is avoided for. An avoided term
 * qualified by a parenthetical ("repo (when the project is meant)") is left out: whether it is wrong
 * depends on what the writer meant, which a match cannot tell.
 */
export function avoidedTermsIn(context: string): AvoidedTerm[] {
  const terms: AvoidedTerm[] = []
  let preferred: string | undefined
  for (const line of context.split('\n')) {
    const entry = /^\*\*(.+?)\*\*:\s*$/.exec(line)
    if (entry) {
      preferred = entry[1]
      continue
    }
    const avoid = /^_Avoid_:\s*(.+)$/.exec(line)
    if (!avoid || preferred === undefined) continue
    for (const item of (avoid[1] ?? '').split(',')) {
      const avoided = item.trim()
      if (avoided !== '' && !avoided.includes('(')) terms.push({ avoided, preferred })
    }
  }
  return terms
}
