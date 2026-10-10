/** Whether a settings group holds a hook running `script`. */
function runs(group: unknown, script: string): boolean {
  const hooks = (group as { hooks?: unknown })?.hooks;
  return (
    Array.isArray(hooks) &&
    hooks.some((hook: { command?: unknown }) =>
      String(hook?.command).includes(script),
    )
  );
}

/**
 * `settings` with a `UserPromptSubmit` hook running `script` merged in beside
 * whatever is already there. A hook already running `script` is replaced, not
 * repeated.
 */
export function withPromptHook(
  settings: Record<string, unknown>,
  script: string,
  command: string,
): Record<string, unknown> {
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const existing = Array.isArray(hooks.UserPromptSubmit)
    ? hooks.UserPromptSubmit
    : [];
  return {
    ...settings,
    hooks: {
      ...hooks,
      UserPromptSubmit: [
        ...existing.filter((group) => !runs(group, script)),
        { hooks: [{ type: "command", command }] },
      ],
    },
  };
}
