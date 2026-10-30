import type { Register } from 'claude-code'

const NEW_ADR = /(^|\/)docs\/adr\/\d{4}-[^/]+\.md$/
const CHECK = 'scripts/check-adr-numbers.ts'

export const register: Register = on => {
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    if (!NEW_ADR.test(e.file_path)) return next(e)

    const cwd = await $.session.cwd()
    const isThisRepo = await $.fs.exists(`${cwd}/${CHECK}`)
    const isNew = !(await $.fs.exists(e.file_path))
    if (!isThisRepo || !isNew) return next(e)

    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    const check = await $.process.run(['node', CHECK], { cwd })
    if (check.exitCode === 0) return ran

    const failure = `${$.plugin.name}: ${e.file_path} breaks the ADR numbering.\n${(check.stderr || check.stdout).trim()}`
    return { ...ran, context: [...(ran.context ?? []), failure] }
  })
}
