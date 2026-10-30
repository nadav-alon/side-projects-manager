/** Where the manager declares the uniform files, relative to its root: the one list `new-project` copies from. */
export const HARNESS_SOURCE = 'src/ports/harness.ts'

const UNIFORM_LIST = /export const UNIFORM_FILES = \[([^\]]*)\]/

/** The uniform files `UNIFORM_FILES` declares in the harness source; empty when it declares none. */
export function uniformFilesIn(harnessSource: string): string[] {
  const list = UNIFORM_LIST.exec(harnessSource)?.[1] ?? ''
  return [...list.matchAll(/"([^"]+)"/g)].map(match => match[1] ?? '')
}
