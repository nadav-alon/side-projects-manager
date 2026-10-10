import { update, read, atom } from 'claude-code'
import type { Register } from 'claude-code'

import { bandLabel, bandOfSkill, colorOfMode, modeSkills } from './modes'

const current = atom({ plugin: 'mode-band', key: 'current' } as const, null)

export const register: Register = on => {
  for (const skill of modeSkills) {
    on('skill.prompt', { skill }, async ($, e, next) => {
      const band = bandOfSkill(e.skill, e.text)
      if (band !== null) {
        const before = await read($, current)
        await update($, current, () => band)
        if (before?.mode !== band.mode) $.ui.toast(`Session mode: ${band.mode}`)
      }

      return next(e)
    })
  }

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const band = await read($, current)
    if (band === null || e.props.hasSurvey) return next(e)

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text color="black" backgroundColor={colorOfMode[band.mode]}>
          {` ${bandLabel(band)} `}
        </Text>
      </Box>
    )
  })
}
