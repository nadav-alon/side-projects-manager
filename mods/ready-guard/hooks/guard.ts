// The ready-for-agent guard: whether a shell call labelling a ticket ready-for-agent may run, given
// the ticket's body and the blockers linked to it. Pure over a tracker reader, so a mod's hook only
// supplies the reads; it imports nothing from the engine.

declare const issueRefBrand: unique symbol

/** A ticket as `owner/repo#n`; values enter through `issueRef` or `isIssueRef`. */
export type IssueRef = string & { readonly [issueRefBrand]: true }

const issueRefPattern = /^[\w.-]+\/[\w.-]+#[1-9]\d*$/

export function isIssueRef(value: string): value is IssueRef {
  return issueRefPattern.test(value)
}

/** Narrows `value` to an `IssueRef`, throwing if it is not shaped like one. */
export function issueRef(value: string): IssueRef {
  if (!isIssueRef(value)) throw new TypeError(`Not an issue ref, expected owner/repo#n: ${JSON.stringify(value)}`)
  return value
}

/** The tracker reads the guard needs, for one ticket. */
export interface Tracker {
  /** The ticket's repo when the call named none: the repo the shell runs in. */
  currentRepo(): Promise<string>
  body(issue: IssueRef): Promise<string>
  /** The tickets linked to `issue` as native blocked-by dependencies. */
  linkedBlockers(issue: IssueRef): Promise<readonly IssueRef[]>
}

/** The ticket a `gh issue edit` adds `ready-for-agent` to; `repo` is null when the call names none. */
export interface ReadyLabelEdit {
  repo: string | null
  number: number
}

const LABEL = 'ready-for-agent'

/** What a call is, or null when it is not a `gh issue edit` adding `ready-for-agent`. */
export function readyLabelEdit(command: string): ReadyLabelEdit | null {
  const words = (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((word) => word.replace(/^(["'])(.*)\1$/, '$2'))
  const start = words.findIndex((word, i) => word === 'gh' && words[i + 1] === 'issue' && words[i + 2] === 'edit')
  if (start === -1) return null
  const args = words.slice(start + 3)

  let repo: string | null = null
  let number: number | null = null
  let isAdding = false
  for (let i = 0; i < args.length; i++) {
    const [, name = args[i]!, inline] = /^(--[\w-]+)=(.*)$/.exec(args[i]!) ?? []
    const takesValue = name === '--repo' || name === '-R' || name === '--add-label'
    const value = inline ?? (takesValue ? args[++i] : undefined)
    if (name === '--repo' || name === '-R') repo = value ?? null
    else if (name === '--add-label') isAdding ||= (value ?? '').split(',').includes(LABEL)
    else if (/^\d+$/.test(name) && number === null) number = Number(name)
  }
  return isAdding && number !== null ? { repo, number } : null
}

/** The tickets a body's Blocked by names, as written: `#n` or `owner/repo#n`. */
export function namedBlockers(body: string): string[] {
  const section = /^#{1,6}\s*Blocked by\s*$([\s\S]*?)(?=^#{1,6}\s|(?![\s\S]))/im.exec(body)?.[1]
  const line = /^Blocked by:(.*)$/im.exec(body)?.[1]
  return [...(section ?? line ?? '').matchAll(/(?:[\w.-]+\/[\w.-]+)?#\d+/g)].map((found) => found[0])
}

/** `null` when the call may run; otherwise the text that denies it. */
export async function denyReadyLabel(command: string, tracker: Tracker): Promise<string | null> {
  const edit = readyLabelEdit(command)
  if (edit === null) return null
  const repo = edit.repo ?? (await tracker.currentRepo())
  const issue = issueRef(`${repo}#${edit.number}`)
  const named = namedBlockers(await tracker.body(issue)).map((ref) => (ref.startsWith('#') ? `${repo}${ref}` : ref))
  const linked = await tracker.linkedBlockers(issue)
  const missing = named.filter((ref) => !linked.includes(ref as IssueRef))
  if (missing.length === 0) return null
  return `${issue} names blockers that are not linked as blocked-by dependencies: ${missing.join(', ')}. Link them first, then add ${LABEL}.`
}
