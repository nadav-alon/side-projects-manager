/** A term the glossary tells writers to avoid, and the glossary term to write instead. */
export interface AvoidedTerm {
  avoided: string
  preferred: string
}

/**
 * The avoided terms a CONTEXT.md glossary lists, each with the entry it is avoided for. An avoided term
 * qualified by a parenthetical ("repo (when the project is meant)") is left out: whether it is wrong
 * depends on what the writer meant, which a match cannot tell. So is one that is itself an entry's name:
 * "run" avoided for Invocation is no mistake where Run is a glossary term.
 */
export function avoidedTermsIn(context: string): AvoidedTerm[] {
  const terms: AvoidedTerm[] = []
  const entries = new Set<string>()
  let preferred: string | undefined
  for (const line of context.split('\n')) {
    const entry = /^\*\*(.+?)\*\*:\s*$/.exec(line)
    if (entry) {
      preferred = entry[1]
      entries.add((preferred ?? '').toLowerCase())
      continue
    }
    const avoid = /^_Avoid_:\s*(.+)$/.exec(line)
    if (!avoid || preferred === undefined) continue
    for (const item of (avoid[1] ?? '').split(',')) {
      const avoided = item.trim()
      if (avoided !== '' && !avoided.includes('(')) terms.push({ avoided, preferred })
    }
  }
  return terms.filter(({ avoided }) => !entries.has(avoided.toLowerCase()))
}

/**
 * The avoided terms `text` uses, once each; a term avoided for several entries names them all in `preferred`.
 * A match inside an identifier (`runId`, `re_run`, `run-id`) does not count.
 */
export function avoidedUses(text: string, terms: readonly AvoidedTerm[]): AvoidedTerm[] {
  const used = new Map<string, string[]>()
  for (const { avoided, preferred } of terms) {
    const escaped = avoided.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
    if (!new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, 'i').test(text)) continue
    const names = used.get(avoided) ?? []
    if (!names.includes(preferred)) names.push(preferred)
    used.set(avoided, names)
  }
  return [...used].map(([avoided, names]) => ({ avoided, preferred: names.join('" or "') }))
}

const DOCUMENT = /\.(md|mdx|txt|rst)$/i
const SLASH_COMMENTS = /\.(ts|tsx|js|jsx|mjs|cjs|java|go|rs|c|h|cpp|cs|swift|kt|scala)$/i
const HASH_COMMENTS = /\.(ya?ml|sh|bash|py|rb|toml)$/i

/**
 * The prose of what is written to `path`: a document without its code, source code as its comments alone.
 * Empty for a file whose comment syntax is unknown, so it is never flagged, and for CONTEXT.md, which lists
 * the avoided terms. A `//` after a colon is a URL, not a comment.
 */
export function proseOf(path: string, content: string): string {
  if (/(^|\/)CONTEXT\.md$/.test(path)) return ''
  if (DOCUMENT.test(path)) {
    // A fence may be indented, and is closed by a fence of the same character at least as long as the opening one.
    return content.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[`~]*[ \t]*$/gm, '').replace(/`[^`\n]*`/g, '')
  }
  if (SLASH_COMMENTS.test(path)) {
    return [...content.matchAll(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g)].map(m => m[0]).join('\n')
  }
  if (HASH_COMMENTS.test(path)) {
    return [...content.matchAll(/(?:^|\s)#[^\n]*/g)].map(m => m[0]).join('\n')
  }
  return ''
}

/** The values of the `--title`/`-t` and `--body`/`-b` flags in a shell command: the prose of an issue or pull request, without its flags and arguments. */
export function issueTextOf(command: string): string {
  const values = command.matchAll(/(?:^|\s)(?:--title|--body|-t|-b)(?:\s+|=)("(?:[^"\\]|\\[\s\S])*"|'[^']*'|\S+)/g)
  return [...values].map(m => (m[1] ?? '').replace(/^["']|["']$/g, '')).join('\n').replace(/`[^`\n]*`/g, '')
}
