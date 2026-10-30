import type { Register } from 'claude-code'

/** The manager's clone: the plugin sits at `<clone>/mods/<name>`, so the commands run from two levels up. */
function managerClone(pluginRoot: string): string {
  return pluginRoot.replace(/\/+$/, '').split('/').slice(0, -2).join('/')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'loop-status', description: "Show the manager's loop status" })
    return next(e)
  })

  on('command.run', { command: 'loop-status' }, async $ => {
    const { exitCode, stdout, stderr } = await $.process.run(['npm', 'run', '--silent', 'status'], {
      cwd: managerClone($.plugin.root),
    })
    const output = (exitCode === 0 ? stdout : stderr || stdout).trim()
    return { text: exitCode === 0 ? output : `loop-status failed (exit ${exitCode}): ${output}` }
  })
}
