// Merges the session-title hook into a Claude settings file: into its
// `hooks.UserPromptSubmit` list, beside whatever is already there. Safe to
// run again; a hook of ours already present is replaced, not repeated.
// Usage: node scripts/install-session-title-hook.ts [settings.json]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const HOOK_SCRIPT = path.join(import.meta.dirname, "session-title-hook.ts");

const settingsPath =
  process.argv[2] ?? path.join(homedir(), ".claude", "settings.json");

function readSettings(): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(settingsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
  const parsed: unknown = text.trim() === "" ? {} : JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${settingsPath} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Whether a settings group holds a hook running our script. */
function isOurs(group: unknown): boolean {
  const hooks = (group as { hooks?: unknown })?.hooks;
  return (
    Array.isArray(hooks) &&
    hooks.some((hook: { command?: unknown }) =>
      String(hook?.command).includes("session-title-hook.ts"),
    )
  );
}

const settings = readSettings();
const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
const existing = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : [];
settings.hooks = {
  ...hooks,
  UserPromptSubmit: [
    ...existing.filter((group) => !isOurs(group)),
    { hooks: [{ type: "command", command: `node ${JSON.stringify(HOOK_SCRIPT)}` }] },
  ],
};

mkdirSync(path.dirname(settingsPath), { recursive: true });
writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
