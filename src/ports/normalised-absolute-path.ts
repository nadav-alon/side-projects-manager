import path from "node:path";

/**
 * Whether `value` is a non-empty absolute path already in the shape
 * `path.join` produces, so two spellings of one path never read as two
 * different ones. Shared by every brand whose values are a directory or file
 * on disk — `Checkout`, `TranscriptDirectory` and `TranscriptPath` all guard
 * on exactly this rule, so it is stated once here rather than copied into
 * each.
 */
export function isNormalisedAbsolutePath(value: string): boolean {
  if (value === "" || !path.isAbsolute(value)) {
    return false;
  }
  // `normalize` keeps a trailing separator, and `/projects/pilot/` is the
  // same directory as `/projects/pilot` — so it is refused here rather than
  // left to read as a second path.
  if (value.length > 1 && value.endsWith(path.sep)) {
    return false;
  }
  return path.normalize(value) === value;
}
