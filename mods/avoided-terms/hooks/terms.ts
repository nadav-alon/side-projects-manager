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

/** The avoided terms `text` uses, once each. A match inside an identifier (`runId`, `re_run`, `run-id`) does not count. */
export function avoidedUses(text: string, terms: readonly AvoidedTerm[]): AvoidedTerm[] {
  return terms.filter(({ avoided }) => {
    const escaped = avoided.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
    return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, 'i').test(text)
  })
}

const DOCUMENT = /\.(md|mdx|txt|rst)$/i
const SLASH_COMMENTS = /\.(ts|tsx|js|jsx|mjs|cjs|java|go|rs|c|h|cpp|cs|swift|kt|scala)$/i

/**
 * The prose of what is written to `path`: a document without its code, source code as its comments alone.
 * Empty for a file whose comment syntax is unknown, so it is never flagged.
 */
export function proseOf(path: string, content: string): string {
  if (DOCUMENT.test(path)) return content.replace(/^(```|~~~)[\s\S]*?^\1.*$/gm, '').replace(/`[^`\n]*`/g, '')
  if (SLASH_COMMENTS.test(path)) {
    return [...content.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g)].map(m => m[0]).join('\n')
  }
  if (/\.(ya?ml|sh|bash|py|rb|toml)$/i.test(path)) {
    return [...content.matchAll(/(?:^|\s)#[^\n]*/g)].map(m => m[0]).join('\n')
  }
  return ''
}
