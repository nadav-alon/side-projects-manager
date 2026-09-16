import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The image the harness is baked into, as `npm run sandbox:build` tags it. */
export const IMAGE = "side-projects-sandbox:latest";

/**
 * The image label `npm run sandbox:build` stamps with `imageInputsDigest`, so
 * a morning can tell whether the image it is about to run still matches the
 * checkout it runs from.
 */
export const INPUTS_LABEL = "side-projects-sandbox.inputs";

/** The checkout root, from `src/adapters` or its built `dist/adapters`. */
export const CHECKOUT_ROOT = path.join(import.meta.dirname, "..", "..");

/**
 * A digest of everything the image bakes in from the checkout: the Dockerfile
 * and each file it `COPY`s. Nothing is rebuilt when these change — the image
 * is built by hand — so a skill added to the checkout is invisible to runs
 * until someone rebuilds, and an agent asked to invoke it answers only
 * "Unknown command". Comparing this against the image's label is what makes
 * that loud.
 *
 * The CLI and plugin the image installs unpinned are not covered: nothing in
 * the checkout says what version they should be. The weekly CI build watches
 * those instead.
 */
export async function imageInputsDigest(root: string): Promise<string> {
  const dockerfile = await readFile(path.join(root, "Dockerfile"), "utf8");
  const hash = createHash("sha256");
  hash.update(`Dockerfile\0${dockerfile}\0`);
  for (const source of copiedSources(dockerfile).sort()) {
    hash.update(`${source}\0`);
    hash.update(await readFile(path.join(root, source)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * The build-context paths a Dockerfile's single-line `COPY`s read. A `COPY
 * --from` reads another stage rather than the checkout, so contributes none.
 */
export function copiedSources(dockerfile: string): string[] {
  return dockerfile
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([instruction]) => instruction?.toUpperCase() === "COPY")
    .flatMap(([, ...args]) => {
      if (args.some((arg) => arg.startsWith("--from"))) {
        return [];
      }
      return args.filter((arg) => !arg.startsWith("--")).slice(0, -1);
    });
}

/**
 * What `readImageLabels` found: the image's labels (empty when it has none),
 * or `"unavailable"` when docker could not inspect it at all.
 */
export type ImageLabels = Readonly<Record<string, string>> | "unavailable";

/** The labels on `IMAGE`, as docker reports them. */
export async function readImageLabels(): Promise<ImageLabels> {
  try {
    const { stdout } = await run("docker", [
      "image",
      "inspect",
      "--format",
      "{{json .Config.Labels}}",
      IMAGE,
    ]);
    const labels: unknown = JSON.parse(stdout);
    return typeof labels === "object" && labels !== null
      ? (labels as Record<string, string>)
      : {};
  } catch {
    return "unavailable";
  }
}

/**
 * A warning to print before a morning starts when the image was built from
 * other inputs than the checkout now holds, or absent when it matches.
 *
 * Also absent when the image cannot be inspected: a missing image or a
 * stopped daemon already fails every run as `AgentNeverRan`, which says so
 * itself.
 */
export async function staleImageWarning(
  root: string,
  labels: ImageLabels,
): Promise<string | undefined> {
  if (labels === "unavailable") {
    return undefined;
  }
  if (labels[INPUTS_LABEL] === (await imageInputsDigest(root))) {
    return undefined;
  }
  return `Warning: the sandbox image ${IMAGE} is out of date with this checkout (its Dockerfile or a skill it bakes in has changed since the build), so runs may fail — a skill added since shows up as "Unknown command". Rebuild it with: npm run sandbox:build`;
}
