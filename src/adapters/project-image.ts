import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { Checkout } from "../ports/checkout.ts";
import { type ImageTag, imageTag } from "../ports/image-tag.ts";
import { type RepoSlug, repoSlug } from "../ports/repo-slug.ts";
import { errorMessage } from "../error-message.ts";
import { IMAGE } from "./sandbox-image.ts";

const run = promisify(execFile);

/**
 * The image label a project's image is stamped with `projectInputsDigest`
 * under, so the next run can tell whether it still matches what the project
 * declares and the shared image it is layered on.
 */
export const PROJECT_INPUTS_LABEL = "side-projects-sandbox.project-inputs";

/** The directory in a project's repo that declares its own toolchain. */
const SANDBOX_DIRECTORY = ".sandbox";

/** The file in `SANDBOX_DIRECTORY` that makes a project's image its own. */
const DOCKERFILE = `${SANDBOX_DIRECTORY}/Dockerfile`;

/** What the project image needs of docker. */
export interface ProjectImageDocker {
  /** The id of the image at `tag`, throwing when there is none. */
  imageId(tag: ImageTag): Promise<string>;
  /** The value of `label` on the image at `tag`, absent when it has none. */
  label(tag: ImageTag, label: string): Promise<string | undefined>;
  /** Builds `directory` as `tag`, stamping `label` with `digest`. */
  build(
    tag: ImageTag,
    directory: string,
    label: string,
    digest: string,
  ): Promise<void>;
}

/** A project's `.sandbox/Dockerfile` that could not be built into an image. */
export class ProjectImageBuildFailed extends Error {
  constructor(project: RepoSlug | Checkout, cause: unknown) {
    super(
      `The sandbox image for ${project} could not be built from its ${DOCKERFILE}, so no run on it starts: ${errorMessage(cause)}`,
    );
    this.name = "ProjectImageBuildFailed";
  }
}

/**
 * `owner/repo` of a managed checkout, which sits at `<location>/<owner>/<repo>`
 * — enough to name the project in a tag and in a failure, without the loop
 * having to hand the sandbox a second value alongside the checkout.
 */
function projectOf(checkout: Checkout): RepoSlug {
  return repoSlug(checkout.split(path.sep).slice(-2).join("/"));
}

/** `projectOf` where the path has the shape, else the path itself. */
function nameOf(checkout: Checkout): RepoSlug | Checkout {
  try {
    return projectOf(checkout);
  } catch {
    return checkout;
  }
}

/**
 * The image tag a project's own image is built as. The owner and repo are
 * joined by `__`, which a GitHub owner cannot contain, so `a-b/c` and `a/b-c`
 * never share an image.
 */
export function projectImageTag(checkout: Checkout): ImageTag {
  return imageTag(`side-projects-sandbox:${projectOf(checkout).replace("/", "__")}`);
}

/**
 * The ref the project image is built from: the checkout's default branch as
 * its remote names it. Never the working tree, and never a run's own branch —
 * a run cannot alter the sandbox it runs in. A checkout whose remote names no
 * default (one not made by `git clone`) is refused rather than guessed at,
 * since its own `HEAD` may sit on any branch.
 */
async function defaultRef(checkout: Checkout): Promise<string> {
  try {
    const { stdout } = await run("git", [
      "-C",
      checkout,
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    return stdout.trim();
  } catch {
    throw new Error(
      "its checkout has no origin/HEAD, so its default branch is unknown",
    );
  }
}

/**
 * Every tracked entry under `.sandbox/` at `ref`, as `git ls-tree` lists it
 * (mode, object id and path), or empty when there is no Dockerfile there.
 */
async function sandboxEntries(checkout: Checkout, ref: string): Promise<string> {
  const { stdout } = await run("git", [
    "-C",
    checkout,
    "ls-tree",
    "-r",
    ref,
    "--",
    SANDBOX_DIRECTORY,
  ]);
  return stdout.split("\n").some((line) => line.endsWith(`\t${DOCKERFILE}`))
    ? stdout
    : "";
}

/** Writes `.sandbox/` as of `ref` into a fresh directory, returning its path. */
async function exportContext(
  checkout: Checkout,
  ref: string,
): Promise<{ directory: string; context: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "project-image-"));
  await run("sh", [
    "-c",
    'git -C "$1" archive "$2" -- "$3" | tar -x -C "$4"',
    "sh",
    checkout,
    ref,
    SANDBOX_DIRECTORY,
    directory,
  ]);
  return { directory, context: path.join(directory, SANDBOX_DIRECTORY) };
}

/**
 * Resolves the image a run on `checkout` executes in, building a project's
 * own when it is stale.
 *
 * A project whose default branch has no `.sandbox/Dockerfile` runs in the
 * shared image, touching nothing in docker. One that has is built from that
 * file and its build context as the default branch holds them, and rebuilt
 * exactly when a digest of those and the shared image's id differs from the
 * one on the existing image's label — so a merged toolchain change and a
 * rebuilt shared image both reach the next run unattended.
 *
 * A failed build throws `ProjectImageBuildFailed` and never falls back to the
 * shared image. The failure is remembered for the lifetime of the returned
 * function, so one project's runs in the same invocation do not each retry
 * a build that has just failed; a build in progress is awaited by the runs
 * that arrive meanwhile rather than started twice.
 */
export function projectImages(
  docker: ProjectImageDocker,
): (checkout: Checkout) => Promise<ImageTag> {
  const builds = new Map<string, Promise<void>>();

  return async (checkout) => {
    try {
      const ref = await defaultRef(checkout);
      const entries = await sandboxEntries(checkout, ref);
      if (entries === "") {
        return IMAGE;
      }
      const tag = projectImageTag(checkout);
      const digest = createHash("sha256")
        .update(`${await docker.imageId(IMAGE)}\0${entries}`)
        .digest("hex");
      if ((await docker.label(tag, PROJECT_INPUTS_LABEL)) === digest) {
        return tag;
      }
      const key = `${tag}@${digest}`;
      let build = builds.get(key);
      if (build === undefined) {
        build = (async () => {
          const { directory, context } = await exportContext(checkout, ref);
          try {
            await docker.build(tag, context, PROJECT_INPUTS_LABEL, digest);
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        })();
        builds.set(key, build);
      }
      await build;
      return tag;
    } catch (error: unknown) {
      throw new ProjectImageBuildFailed(nameOf(checkout), error);
    }
  };
}

/** `ProjectImageDocker` over the `docker` CLI. */
export const dockerCli: ProjectImageDocker = {
  async imageId(tag) {
    const { stdout } = await run("docker", [
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      tag,
    ]);
    return stdout.trim();
  },
  async label(tag, label) {
    try {
      const { stdout } = await run("docker", [
        "image",
        "inspect",
        "--format",
        `{{index .Config.Labels "${label}"}}`,
        tag,
      ]);
      const value = stdout.trim();
      return value === "" ? undefined : value;
    } catch {
      return undefined;
    }
  },
  async build(tag, directory, label, digest) {
    try {
      // `--network host` as `npm run sandbox:build` has it: on WSL the default
      // bridge times out on downloads. BuildKit streams every `RUN` step to
      // stderr, so the buffer is as large as the other adapters' rather than
      // execFile's 1 MiB, which would kill a toolchain build part way.
      await run(
        "docker",
        [
          "build",
          "--network",
          "host",
          "--tag",
          tag,
          "--label",
          `${label}=${digest}`,
          directory,
        ],
        { maxBuffer: 16 * 1024 * 1024 },
      );
    } catch (error: unknown) {
      const stderr = (error as { stderr?: unknown }).stderr;
      throw new Error(
        typeof stderr === "string" && stderr.trim() !== ""
          ? stderr.trim().split("\n").slice(-10).join("\n")
          : errorMessage(error),
      );
    }
  },
};
