import type { Register } from 'claude-code'

import { bandLabel, isInReserve } from './band'
import { managerHomeReader } from './manager-home/reader'
import { sessionLogsFolder } from './session-logs'

/** The manager home is the checkout this mod sits in: `<home>/mods/budget-band`. */
const homeOf = (pluginRoot: string) => pluginRoot.replace(/\/mods\/budget-band\/*$/, '')

export const register: Register = on => {
  // The config directory cannot change during a session, so the shell is asked once.
  let logs: ReturnType<typeof sessionLogsFolder> | undefined

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const fs = { read: (path: string) => $.fs.read(path), list: (path: string) => $.fs.list(path) }
    const reader = managerHomeReader(fs, homeOf($.plugin.root), await (logs ??= sessionLogsFolder(argv => $.process.run(argv))))
    const usage = await reader.fiveHourUsage(new Date(await $.clock.now()))
    // Whatever draws beneath stays: this band stacks on top of it.
    const below = await next(e)
    if (usage === undefined) return below

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Text color="black" backgroundColor={isInReserve(usage) ? 'yellow' : 'green'}>
          {` ${bandLabel(usage)} `}
        </Text>
        {below}
      </Box>
    )
  })
}
