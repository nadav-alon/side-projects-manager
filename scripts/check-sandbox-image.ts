// Prints the warning an image built from other inputs than the checkout now
// holds earns — the same one a morning prints before its first run — and
// nothing at all when the image matches, or when docker cannot be reached to
// say either way (`staleImageWarning`). Silence being the common case is what
// makes it bearable on every merge: `.githooks/post-merge` is the caller.

import {
  CHECKOUT_ROOT,
  readImageLabels,
  staleImageWarning,
} from "../src/adapters/sandbox-image.ts";

const warning = await staleImageWarning(CHECKOUT_ROOT, await readImageLabels());
if (warning !== undefined) {
  console.log(warning);
}
