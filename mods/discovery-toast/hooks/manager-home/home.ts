// Where the manager home is, for a mod: `SIDE_PROJECTS_MANAGER_HOME` when it holds an absolute path,
// else the checkout the mod sits in (`<checkout>/mods/<name>`), as `src/adapters/manager-home.ts` resolves
// it. A mod carries a copy of this file beside `reader.ts`, kept byte-identical by `copies.test.ts`.

/** An absolute path with no trailing slash, the manager home. */
export type ManagerHome = string & { readonly managerHomeBrand: true }

/** The shell command that prints `SIDE_PROJECTS_MANAGER_HOME`; the hooks run without `process`, so the shell is asked. */
export const HOME_COMMAND: readonly string[] = ['sh', '-c', 'printf "%s" "$SIDE_PROJECTS_MANAGER_HOME"']

/** The part of the engine's `$.process.run` the lookup uses. */
export type RunProcess = (argv: string[]) => Promise<{ exitCode: number; stdout: string }>

/** The home for the variable's value `override` and the mod's `pluginRoot`: an unset, empty or relative override falls back to the checkout. */
export function managerHomeOf(override: string, pluginRoot: string): ManagerHome {
  const given = override.trim()
  const home = given.startsWith('/') ? given : pluginRoot.replace(/\/+$/, '').split('/').slice(0, -2).join('/')
  return (home.replace(/\/+$/, '') || '/') as ManagerHome
}

/** The home, asking the shell for the variable. A shell that fails or throws leaves the checkout, never a failed hook. */
export async function resolveManagerHome(run: RunProcess, pluginRoot: string): Promise<ManagerHome> {
  try {
    const { exitCode, stdout } = await run([...HOME_COMMAND])
    return managerHomeOf(exitCode === 0 ? stdout : '', pluginRoot)
  } catch {
    return managerHomeOf('', pluginRoot)
  }
}
