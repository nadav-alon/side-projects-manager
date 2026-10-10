import { isNormalisedAbsolutePath } from "./normalised-absolute-path.ts";

declare const hostPathBrand: unique symbol;
declare const containerPathBrand: unique symbol;

/**
 * An absolute path on the host to a directory a project's registry entry
 * declares for its runs to read. Distinct from `ContainerPath`, where the same
 * directory is seen from inside the run: swapping the two would mount the
 * wrong side. Values enter through `hostPath` or `isHostPath`.
 */
export type HostPath = string & { readonly [hostPathBrand]: true };

/** Whether `value` is an absolute path in the shape `path.join` produces. */
export function isHostPath(value: string): value is HostPath {
  return isNormalisedAbsolutePath(value);
}

/** Narrows `value` to a `HostPath`, throwing if it is not one. */
export function hostPath(value: string): HostPath {
  if (!isHostPath(value)) {
    throw new TypeError(
      `Not a host path: expected a normalised absolute path, got ${JSON.stringify(value)}`,
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
      `Not a container path: expected a normalised absolute path other than "/", got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * A host directory a project's runs see at `container`, never writable: the
 * registry offers no way to declare one that is.
 */
export interface ReadOnlyMount {
  host: HostPath;
  container: ContainerPath;
}
