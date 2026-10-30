/** Where the manager declares the uniform files, relative to the manager home: the one list `new-project` copies from. */
export const HARNESS_SOURCE = 'src/ports/harness.ts'

const UNIFORM_LIST = /export const UNIFORM_FILES = \[([^\]]*)\]/

/** The uniform files `UNIFORM_FILES` declares in the harness source; empty when it declares none. */
export function uniformFilesIn(harnessSource: string): string[] {
  const list = UNIFORM_LIST.exec(harnessSource)?.[1] ?? ''
  return [...list.matchAll(/"([^"]+)"/g)].map(match => match[1] ?? '')
}

/** `filePath` relative to the manager home with `.`, `..` and repeated slashes resolved; undefined when it lies outside it. */
export function relativeToHome(home: string, filePath: string): string | undefined {
  const parts: string[] = []
  for (const part of (filePath.startsWith('/') ? filePath : `${home}/${filePath}`).split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '' && part !== '.') parts.push(part)
  }
  const homeParts = home.split('/').filter(part => part !== '' && part !== '.')
  if (homeParts.some((part, i) => parts[i] !== part) || parts.length <= homeParts.length) return undefined
  return parts.slice(homeParts.length).join('/')
}
