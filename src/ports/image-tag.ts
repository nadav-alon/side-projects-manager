declare const imageTagBrand: unique symbol;

/**
 * A docker image reference in `name:tag` form: what a run's container is
 * started from.
 *
 * Branded, because an image, a repo slug and a checkout path are all strings,
 * and the compiler would hand any of them to `docker run`. Values enter
 * through `imageTag` or `isImageTag`.
 */
export type ImageTag = string & { readonly [imageTagBrand]: true };

/** A lowercase repository name, a colon, and a tag docker accepts. */
const SHAPE = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** Whether `value` is a `name:tag` reference docker would accept. */
export function isImageTag(value: string): value is ImageTag {
  return SHAPE.test(value);
}

/** Narrows `value` to an `ImageTag`, throwing if it is not one. */
export function imageTag(value: string): ImageTag {
  if (!isImageTag(value)) {
    throw new TypeError(`Not an image tag: expected name:tag, got ${value}`);
  }
  return value;
}
