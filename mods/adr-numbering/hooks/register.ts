import type { Register } from 'claude-code'

// Restates the ADR file name format owned by src/adr-numbers.ts; a mod is self-contained, so it cannot import it.
const ADR_FILE = /^\d{4}-[^/]+\.md$/
// Run from the session's cwd, so its presence there also marks the cwd as this repo's root.
const CHECK = 'scripts/check-adr-numbers.ts'

export const register: Register = on => {
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const cwd = await $.session.cwd()
    const written = e.file_path.startsWith('/') ? e.file_path : `${cwd}/${e.file_path}`
    const adrDir = `${cwd}/docs/adr/`
    const name = written.slice(adrDir.length)
    if (!written.startsWith(adrDir) || !ADR_FILE.test(name)) return next(e)

    const isThisRepo = await $.fs.exists(`${cwd}/${CHECK}`)
    const isNew = !(await $.fs.exists(written))
    if (!isThisRepo || !isNew) return next(e)

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    const check = await $.process.run(['node', CHECK], { cwd })
    if (check.exitCode === 0) return ran

    // The check scans every ADR; report only the collisions this file is part of.
    const ours = (check.stderr || check.stdout).split('\n').filter(line => line.includes(name))
    if (ours.length === 0) return ran

    const failure = `${$.plugin.name}: ${e.file_path} breaks the ADR numbering.\n${ours.join('\n')}`
    return { ...ran, context: [...(ran.context ?? []), failure] }
  })
}
