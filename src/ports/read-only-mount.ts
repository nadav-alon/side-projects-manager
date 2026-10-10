import { isNormalisedAbsolutePath } from "./normalised-absolute-path.ts";

declare const hostDirectoryBrand: unique symbol;
declare const containerPathBrand: unique symbol;

/**
 * An absolute path on the host to a directory a project's registry entry
 * declares for its runs to read. Distinct from `ContainerPath`, where the same
 * directory is seen from inside the run: swapping the two would mount the
 * wrong side. Values enter through `hostDirectory` or `isHostDirectory`.
 */
export type HostDirectory = string & { readonly [hostDirectoryBrand]: true };

/** Whether `value` is an absolute path in the shape `path.join` produces. */
export function isHostDirectory(value: string): value is HostDirectory {
  return isNormalisedAbsolutePath(value);
}

/** Narrows `value` to a `HostDirectory`, throwing if it is not one. */
export function hostDirectory(value: string): HostDirectory {
  if (!isHostDirectory(value)) {
    throw new TypeError(
      `Not a host directory: expected a normalised absolute path, got ${value}`,
    );
  }
  return value;
}

/**
 * Where a `ReadOnlyMount` appears inside a run's container. Absolute, and not
 * the root: docker refuses to mount over `/`.
 */
export type ContainerPath = string & { readonly [containerPathBrand]: true };

/** Whether `value` is an absolute container path other than `/`. */
export function isContainerPath(value: string): value is ContainerPath {
  return value !== "/" && isNormalisedAbsolutePath(value);
}

/** Narrows `value` to a `ContainerPath`, throwing if it is not one. */
export function containerPath(value: string): ContainerPath {
  if (!isContainerPath(value)) {
    throw new TypeError(
      `Not a container path: expected a normalised absolute path other than "/", got ${value}`,
    );
  }
  return value;
}

/**
 * A host directory a project's runs see at `container`, never writable: the
 * registry offers no way to declare one that is.
 */
export interface ReadOnlyMount {
  host: HostDirectory;
  container: ContainerPath;
}
