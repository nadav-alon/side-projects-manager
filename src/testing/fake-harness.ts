import type { Harness, Scaffold } from "../ports/index.ts";

/** One scaffolding, as the command asked for it. */
export interface FakeInstall {
  directory: string;
  instructions: string;
}

/**
 * Scaffolding in memory. Nothing is copied anywhere; the fake records what it
 * was asked to install, so a test can assert which checkout was scaffolded and
 * what the generated instructions said, without a filesystem.
 *
 * The uniform files it claims to install are a stand-in list, not the real
 * payload: which files those are is the adapter's fact, and is asserted there.
 */
export class FakeHarness implements Harness {
  static readonly UNIFORM_FILES = ["docs/agents/issue-tracker.md"];
  static readonly INSTRUCTIONS_FILE = "AGENTS.md";

  /** Every install asked for, in order. */
  readonly installs: FakeInstall[] = [];

  /**
   * The paths the next install reports as having replaced a file the project
   * already had, which is what scaffolding a repo that predates the manager
   * looks like.
   */
  overwrites: string[] = [];

  async install(directory: string, instructions: string): Promise<Scaffold> {
    this.installs.push({ directory, instructions });
    return {
      paths: [...FakeHarness.UNIFORM_FILES, FakeHarness.INSTRUCTIONS_FILE],
      overwritten: [...this.overwrites],
    };
  }
}
