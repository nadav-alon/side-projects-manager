const NAME = /side[- ]projects?[- ]manager/i

/** The line of the text that names this repo, or undefined when none does. */
export function lineNamingRepo(text: string): string | undefined {
  return text.split('\n').find(line => NAME.test(line))?.trim()
}
