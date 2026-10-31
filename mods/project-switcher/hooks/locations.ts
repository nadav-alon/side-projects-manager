import type { AbsolutePath } from '../types'
import { absolutePath } from './switcher.ts'

/** Where the manager keeps its registry and where it clones projects, resolved as `src/adapters/manager-home.ts` resolves them. */
export interface Locations {
  home: AbsolutePath
  managed: AbsolutePath
}

/** `checkoutRoot` is this checkout's own root, never the working directory, so the pane finds the registry from wherever it is started. */
export function locations(env: Record<string, string | undefined>, checkoutRoot: string): Locations {
  const home = absolutePath(env['SIDE_PROJECTS_MANAGER_HOME'] || checkoutRoot)
  const managed = absolutePath(env['SIDE_PROJECTS_MANAGED_LOCATION'] || `${env['HOME'] || home}/side-projects`)
  return { home, managed }
}
