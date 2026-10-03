declare const standardsPresetBrand: unique symbol;

/**
 * The name of one of the manager's standards presets, e.g. `"typescript"` —
 * the stem of a file under `docs/project-standards-presets/`, so lower-case
 * words joined by hyphens and never a path.
 *
 * Branded, because it travels from the command line to a directory lookup as
 * one of several strings the scaffold passes around, and a name that is not a
 * stem must never reach a path. Whether a preset of that name exists is the
 * harness's to say. Values enter through `standardsPreset` or
 * `isStandardsPreset`.
 */
export type StandardsPreset = string & { readonly [standardsPresetBrand]: true };

const PRESET_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Whether `value` is shaped like a preset's file stem. */
export function isStandardsPreset(value: string): value is StandardsPreset {
  return PRESET_NAME.test(value);
}

/** Narrows `value` to a `StandardsPreset`, throwing if it is not one. */
export function standardsPreset(value: string): StandardsPreset {
  if (!isStandardsPreset(value)) {
    throw new TypeError(
      `Not a standards preset name, expected lower-case words joined by hyphens: ${value}`,
    );
  }
  return value;
}
