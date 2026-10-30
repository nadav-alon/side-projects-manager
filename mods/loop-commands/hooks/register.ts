import type { Register } from 'claude-code'
import { parseTicketReference } from './ticket-reference'

/** The manager home: the plugin sits at `<home>/mods/<name>`, so the commands run from two levels up. */
function managerHome(pluginRoot: string): string {
  return pluginRoot.replace(/\/+$/, '').split('/').slice(0, -2).join('/')
}

const YES = 'Yes'
const NO = 'No'

/** A manager command a slash command runs; `confirm` names the question asked first, when it asks one. */
type LoopCommand = {
  description: string
  script: string
  /** The script's arguments, or `undefined` when `args` are not usable and `usage` is shown instead. */
  scriptArgs: (args: string) => string[] | undefined
  usage?: string
  confirm?: (args: string) => string
}

const GRANT_USAGE = 'Usage: /grant owner/repo#n'

const COMMANDS: Record<string, LoopCommand> = {
  'loop-status': { description: "Show the manager's morning loop status", script: 'status', scriptArgs: () => [] },
  resume: { description: 'Resume the morning loop after a halt', script: 'resume', scriptArgs: () => [] },
  halt: {
    description: 'Halt the morning loop until it is resumed',
    script: 'halt',
    scriptArgs: () => [],
    confirm: () => 'Halt the morning loop?',
  },
  // Grants the default label, `turboable`, only: the ticket names `/grant <repo#n>`, so `live-write` stays on `npm run grant`.
  grant: {
    description: 'Grant turboable on a ticket: /grant owner/repo#n',
    script: 'grant',
    scriptArgs: args => {
      const ticket = parseTicketReference(args)
      return ticket === undefined ? undefined : ['--', ticket]
    },
    usage: GRANT_USAGE,
    confirm: args => `Grant turboable on ${parseTicketReference(args)} so the morning loop may merge it?`,
  },
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const [name, { description }] of Object.entries(COMMANDS)) await $.command.register({ name, description })
    return next(e)
  })

  for (const [name, command] of Object.entries(COMMANDS)) {
    on('command.run', { command: name }, async ($, e) => {
      const scriptArgs = command.scriptArgs(e.args)
      if (scriptArgs === undefined) return { text: command.usage ?? '' }
      if (command.confirm !== undefined) {
        const answer = await $.ui.ask(command.confirm(e.args), [YES, NO]).catch(() => NO)
        if (answer !== YES) return { text: `/${name} cancelled.` }
      }
      let result
      try {
        result = await $.process.run(['npm', 'run', '--silent', command.script, ...scriptArgs], { cwd: managerHome($.plugin.root) })
      } catch (error) {
        return { text: `/${name} failed: ${error instanceof Error ? error.message : String(error)}` }
      }
      const { exitCode, stdout, stderr } = result
      const output = (exitCode === 0 ? stdout : stderr || stdout).trim()
      return { text: exitCode === 0 ? output : `/${name} failed (exit ${exitCode}): ${output}` }
    })
  }
}
