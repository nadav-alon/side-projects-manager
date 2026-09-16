// Prints the digest `npm run sandbox:build` stamps the image with, so a
// morning can tell a stale image from a current one (`staleImageWarning`).

import { CHECKOUT_ROOT, imageInputsDigest } from "../src/adapters/sandbox-image.ts";

console.log(await imageInputsDigest(CHECKOUT_ROOT));
