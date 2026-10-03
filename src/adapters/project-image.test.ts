import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { type Checkout, checkout } from "../ports/checkout.ts";
import type { ImageTag } from "../ports/image-tag.ts";
import {
  PROJECT_INPUTS_LABEL,
  ProjectImageBuildFailed,
  type ProjectImageDocker,
  projectImageTag,
  projectImages,
} from "./project-image.ts";
import { IMAGE } from "./sandbox-image.ts";

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" });
}

/** A managed-location checkout of `owner/repo` with one commit on `main`. */
async function project(files: Record<string, string>): Promise<Checkout> {
  const root = await mkdtemp(path.join(tmpdir(), "project-image-test-"));
  const directory = path.join(root, "owner", "repo");
  await mkdir(directory, { recursive: true });
  git(directory, "init", "--quiet", "--initial-branch=main");
  git(directory, "config", "user.email", "t@example.com");
  git(directory, "config", "user.name", "t");
  await commit(checkout(directory), files);
  git(directory, "remote", "add", "origin", directory);
  git(directory, "fetch", "--quiet", "origin");
  git(directory, "remote", "set-head", "origin", "main");
  return checkout(directory);
}

async function commit(directory: Checkout, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), content);
  }
  git(directory, "add", "-A");
  git(directory, "commit", "--quiet", "--allow-empty", "-m", "change");
  // The remote's view of main follows main, as a fetch after a merge would.
  if (git(directory, "branch", "--show-current").trim() === "main") {
    git(directory, "update-ref", "refs/remotes/origin/main", "HEAD");
  }
}

/** A docker that remembers what it built and what each build carried. */
function fakeDocker(options: { failBuild?: string } = {}) {
  const labels = new Map<string, string>();
  const built: { tag: ImageTag; dockerfile: string }[] = [];
  let sharedId = "sha256:one";
  const docker: ProjectImageDocker = {
    async imageId() {
      return sharedId;
    },
    async label(tag, label) {
      assert.equal(label, PROJECT_INPUTS_LABEL);
      return labels.get(tag);
    },
    async build(tag, directory, _label, digest) {
      if (options.failBuild !== undefined) {
        throw new Error(options.failBuild);
      }
      built.push({
        tag,
        dockerfile: await readFile(path.join(directory, "Dockerfile"), "utf8"),
      });
      labels.set(tag, digest);
    },
  };
  return {
    docker,
    built,
    rebuildShared: () => {
      sharedId = "sha256:two";
    },
  };
}

const DECLARED = { ".sandbox/Dockerfile": "FROM side-projects-sandbox:latest\nRUN a\n" };

describe("projectImages", () => {
  it("runs a project without .sandbox/Dockerfile in the shared image, touching no docker", async () => {
    const dir = await project({ "README.md": "x" });
    const { docker, built } = fakeDocker();
    assert.equal(await projectImages(docker)(dir), IMAGE);
    assert.deepEqual(built, []);
  });

  it("builds the project's own image from its Dockerfile when none exists yet", async () => {
    const dir = await project(DECLARED);
    const { docker, built } = fakeDocker();
    assert.equal(await projectImages(docker)(dir), projectImageTag(dir));
    assert.deepEqual(built, [
      { tag: projectImageTag(dir), dockerfile: DECLARED[".sandbox/Dockerfile"] },
    ]);
  });

  it("reuses the image without a build when nothing changed", async () => {
    const dir = await project(DECLARED);
    const { docker, built } = fakeDocker();
    await projectImages(docker)(dir);
    await projectImages(docker)(dir);
    assert.equal(built.length, 1);
  });

  it("rebuilds when the Dockerfile, another file in .sandbox/, or the shared image changed", async () => {
    const dir = await project({ ...DECLARED, ".sandbox/setup.sh": "one" });
    const { docker, built, rebuildShared } = fakeDocker();
    const images = projectImages(docker);
    await images(dir);

    await commit(dir, { ".sandbox/Dockerfile": "FROM side-projects-sandbox:latest\nRUN b\n" });
    await images(dir);
    assert.equal(built.length, 2);

    await commit(dir, { ".sandbox/setup.sh": "two" });
    await images(dir);
    assert.equal(built.length, 3);

    rebuildShared();
    await images(dir);
    assert.equal(built.length, 4);
  });

  it("is not moved by a change outside .sandbox/", async () => {
    const dir = await project(DECLARED);
    const { docker, built } = fakeDocker();
    const images = projectImages(docker);
    await images(dir);
    await commit(dir, { "src/a.ts": "x" });
    await images(dir);
    assert.equal(built.length, 1);
  });

  it("ignores a .sandbox/Dockerfile on another branch, or in the working tree", async () => {
    const dir = await project(DECLARED);
    git(dir, "checkout", "--quiet", "-b", "issue-1-run");
    await commit(dir, { ".sandbox/Dockerfile": "FROM side-projects-sandbox:latest\nRUN branch\n" });
    await writeFile(path.join(dir, ".sandbox", "Dockerfile"), "dirty");
    const { docker, built } = fakeDocker();
    await projectImages(docker)(dir);
    assert.equal(built[0]?.dockerfile, DECLARED[".sandbox/Dockerfile"]);
  });

  it("refuses with the project and the failure, never falling back to the shared image", async () => {
    const dir = await project(DECLARED);
    const { docker } = fakeDocker({ failBuild: "apt exploded" });
    const images = projectImages(docker);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(images(dir), (error: unknown) => {
        assert.ok(error instanceof ProjectImageBuildFailed);
        assert.match(error.message, /owner\/repo/);
        assert.match(error.message, /apt exploded/);
        return true;
      });
    }
  });

  it("names the project when its checkout cannot even be read", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "project-image-test-"));
    const directory = path.join(root, "owner", "repo");
    await mkdir(directory, { recursive: true });
    const { docker } = fakeDocker();
    await assert.rejects(
      projectImages(docker)(checkout(directory)),
      (error: unknown) =>
        error instanceof ProjectImageBuildFailed &&
        /owner\/repo/.test(error.message),
    );
  });

  it("refuses a checkout whose remote names no default branch rather than guessing its HEAD", async () => {
    const dir = await project(DECLARED);
    git(dir, "remote", "set-head", "origin", "--delete");
    const { docker, built } = fakeDocker();
    await assert.rejects(projectImages(docker)(dir), (error: unknown) => {
      assert.ok(error instanceof ProjectImageBuildFailed);
      assert.match(error.message, /owner\/repo/);
      assert.match(error.message, /origin\/HEAD/);
      return true;
    });
    assert.deepEqual(built, []);
  });

  it("builds once for runs that arrive while it is building", async () => {
    const dir = await project(DECLARED);
    const { docker, built } = fakeDocker();
    const images = projectImages(docker);
    await Promise.all([images(dir), images(dir), images(dir)]);
    assert.equal(built.length, 1);
  });
});
