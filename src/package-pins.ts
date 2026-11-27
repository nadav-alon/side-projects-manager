import { isReleaseTag, type ReleaseTag, type RepoOwner } from "./ports/index.ts";

/** One dependency a `package.json` pins to a release of a GitHub repo. */
export interface PackagePin {
  /** The pinned repo's name, the `<package>` of `github:<owner>/<package>#v…`. */
  package: string;
  tag: ReleaseTag;
}

/**
 * Every dependency `packageJson` pins as `github:<owner>/<package>#v…`, from
 * `dependencies`, `devDependencies` and `optionalDependencies`. A spec that
 * names another owner, no tag, or a tag that is not a release tag is not a
 * pin. Text that is not a JSON object yields none: a project whose manifest
 * cannot be read pins nothing this loop can bump.
 */
export function packagePins(packageJson: string, owner: RepoOwner): PackagePin[] {
  let manifest: unknown;
  try {
    manifest = JSON.parse(packageJson);
  } catch {
    return [];
  }
  if (typeof manifest !== "object" || manifest === null) {
    return [];
  }
  const prefix = `github:${owner}/`;
  const pins: PackagePin[] = [];
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const dependencies: unknown = (manifest as Record<string, unknown>)[section];
    if (typeof dependencies !== "object" || dependencies === null) {
      continue;
    }
    for (const spec of Object.values(dependencies)) {
      if (typeof spec !== "string" || !spec.startsWith(prefix)) {
        continue;
      }
      const [name, tag] = spec.slice(prefix.length).split("#");
      if (name !== undefined && name !== "" && tag !== undefined && isReleaseTag(tag)) {
        pins.push({ package: name, tag });
      }
    }
  }
  return pins;
}
