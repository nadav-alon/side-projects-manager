import type { Register } from 'claude-code'

/** The manager's clone: the plugin sits at `<clone>/mods/<name>`, so the commands run from two levels up. */
function managerClone(pluginRoot: string): string {
  return pluginRoot.replace(/\/+$/, '').split('/').slice(0, -2).join('/')
}

const YES = 'Yes'
const NO = 'No'

const GRANT_USAGE = 'Usage: /grant owner/repo#n'
const TICKET = /^[\w.-]+\/[\w.-]+#[1-9]\d*$/

/** The manager commands a slash command runs; `confirm` names the question asked first, when it asks one. */
const COMMANDS = {
  'loop-status': { description: "Show the manager's loop status", script: 'status' },
  resume: { description: "Resume the manager's loop after a halt", script: 'resume' },
  halt: { description: "Halt the manager's loop until it is resumed", script: 'halt', confirm: () => 'Halt the manager loop?' },
  grant: {
    description: 'Grant a ticket to the loop: /grant owner/repo#n',
    script: 'grant',
    scriptArgs: (args: string) => (TICKET.test(args.trim()) ? ['--', args.trim()] : undefined),
    usage: GRANT_USAGE,
    confirm: (args: string) => `Grant ${args.trim()} to the manager loop?`,
  },
} as const

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const [name, { description }] of Object.entries(COMMANDS)) await $.command.register({ name, description })
    return next(e)
  })

  for (const [name, command] of Object.entries(COMMANDS)) {
    on('command.run', { command: name }, async ($, e) => {
      const scriptArgs = 'scriptArgs' in command ? command.scriptArgs(e.args) : []
      if (scriptArgs === undefined) return { text: command.usage }
      if ('confirm' in command) {
        const answer = await $.ui.ask(command.confirm(e.args), [YES, NO]).catch(() => NO)
        if (answer !== YES) return { text: `/${name} cancelled.` }
      }
      const { exitCode, stdout, stderr } = await $.process.run(['npm', 'run', '--silent', command.script, ...scriptArgs], {
        cwd: managerClone($.plugin.root),
      })
      const output = (exitCode === 0 ? stdout : stderr || stdout).trim()
      return { text: exitCode === 0 ? output : `/${name} failed (exit ${exitCode}): ${output}` }
    })
  }
}
