import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  CHECKOUT_ROOT,
  INPUTS_LABEL,
  copiedSources,
  imageInputsDigest,
  staleImageWarning,
} from "./sandbox-image.ts";

const DOCKERFILE = [
  "FROM node:22-slim",
  "COPY --chown=node:node skills/a/SKILL.md $HOME/.claude/skills/a/SKILL.md",
  "COPY --from=build /out /app",
  "RUN echo COPY not-an-instruction",
].join("\n");

/** A checkout holding `DOCKERFILE` and the one file it copies. */
async function checkoutRoot(skill = "first"): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sandbox-image-"));
  await writeFile(path.join(root, "Dockerfile"), DOCKERFILE);
  await mkdir(path.join(root, "skills", "a"), { recursive: true });
  await writeFile(path.join(root, "skills", "a", "SKILL.md"), skill);
  return root;
}

describe("copiedSources", () => {
  it("names each COPY's sources, skipping flags, destinations and other stages", () => {
    assert.deepEqual(copiedSources(DOCKERFILE), ["skills/a/SKILL.md"]);
  });

  it("finds every file this repo's Dockerfile copies", async () => {
    // Reading the digest proves each source exists where the parser says.
    await imageInputsDigest(CHECKOUT_ROOT);
  });
});

describe("staleImageWarning", () => {
  it("is silent for an image stamped with the checkout's inputs", async () => {
    const root = await checkoutRoot();
    const labels = { [INPUTS_LABEL]: await imageInputsDigest(root) };

    assert.equal(await staleImageWarning(root, labels), undefined);
  });

  it("warns once a copied file changes after the build", async () => {
    const built = await checkoutRoot("first");
    const labels = { [INPUTS_LABEL]: await imageInputsDigest(built) };
    const now = await checkoutRoot("second");

    assert.match(
      (await staleImageWarning(now, labels)) ?? "",
      /out of date.*npm run sandbox:build/,
    );
  });

  it("warns for an image built before it was stamped", async () => {
    const root = await checkoutRoot();

    assert.match((await staleImageWarning(root, {})) ?? "", /out of date/);
  });

  it("leaves an image docker cannot inspect to the run that needs it", async () => {
    const root = await checkoutRoot();

    assert.equal(await staleImageWarning(root, "unavailable"), undefined);
  });
});
