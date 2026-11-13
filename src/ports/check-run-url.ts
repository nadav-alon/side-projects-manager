declare const checkRunUrlBrand: unique symbol;

/**
 * The web address of a failing check's run, as GitHub's `statusCheckRollup`
 * reports it: an Actions job or run page, or a legacy status context's
 * `targetUrl` on whatever service ran it.
 *
 * Branded, so the pull request's own address, a different kind of URL, cannot
 * stand in for a link to the run. Values enter through `checkRunUrl` or
 * `isCheckRunUrl`, which are the only places the shape is checked.
 */
export type CheckRunUrl = string & { readonly [checkRunUrlBrand]: true };

/** Whether `value` is an `http(s)` URL: the host is any, since a status context may link any CI service. */
export function isCheckRunUrl(value: string): value is CheckRunUrl {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** Narrows `value` to a `CheckRunUrl`, throwing if it is not one. */
export function checkRunUrl(value: string): CheckRunUrl {
  if (!isCheckRunUrl(value)) {
    throw new TypeError(`Not a check run URL: expected an http(s) URL, got ${JSON.stringify(value)}`);
  }
  return value;
}
