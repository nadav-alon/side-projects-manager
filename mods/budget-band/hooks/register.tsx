import type { Register } from 'claude-code'

import { bandLabel, isInReserve } from './band'
import { managerHomeReader } from './manager-home/reader'

/** The manager home is the checkout this mod sits in: `<home>/mods/budget-band`. */
const homeOf = (pluginRoot: string) => pluginRoot.replace(/\/mods\/budget-band\/*$/, '')

export const register: Register = on => {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const fs = { read: (path: string) => $.fs.read(path), list: (path: string) => $.fs.list(path) }
    const reader = managerHomeReader(fs, homeOf($.plugin.root))
    const usage = await reader.fiveHourUsage(new Date(await $.clock.now()))
    if (usage === undefined) return next(e)

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text color="black" backgroundColor={isInReserve(usage) ? 'yellow' : 'green'}>
          {` ${bandLabel(usage)} `}
        </Text>
      </Box>
    )
  })
}
