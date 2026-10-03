import type { Checkout, Harness, Scaffold, UniformComparison } from "../ports/index.ts";
import { UNIFORM_FILES } from "../ports/index.ts";

/** One scaffolding, as the command asked for it. */
export interface FakeInstall {
  directory: Checkout;
  instructions: string;
  standards: string;
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
  static readonly STANDARDS_FILE = "docs/project-standards.md";

  /** Every install asked for, in order. */
  readonly installs: FakeInstall[] = [];

  /**
   * The paths the next install reports as having replaced a file the project
   * already had, which is what scaffolding a repo that predates the manager
   * looks like.
   */
  overwrites: string[] = [];

  /** Every checkout `sync` was asked to bring in step, in order. */
  readonly syncs: Checkout[] = [];

  /**
   * What the next `sync` reports as changed, and copies. None, unless a test
   * says otherwise — the same default a checkout already in step would read
   * as.
   */
  changed: string[] = [];

  /**
   * What `compareUniform` answers, by content. `"different"` for any content
   * a test has not placed here.
   */
  readonly comparisons = new Map<string, UniformComparison>();

  /** The presets the fake knows, by name; the text is a stand-in for the file. */
  static readonly PRESETS = ["typescript"];

  /** Every preset name `standards` was asked for, in order; undefined for the stub. */
  readonly standardsAsked: (string | undefined)[] = [];

  async standards(preset?: string): Promise<string> {
    this.standardsAsked.push(preset);
    if (preset === undefined) {
      return "stub standards";
    }
    if (!FakeHarness.PRESETS.includes(preset)) {
      throw new Error(
        `No standards preset named ${JSON.stringify(preset)}; the presets are: ${FakeHarness.PRESETS.join(", ")}.`,
      );
    }
    return `${preset} standards`;
  }

  async install(
    directory: Checkout,
    instructions: string,
    standards: string,
  ): Promise<Scaffold> {
    this.installs.push({ directory, instructions, standards });
    return {
      paths: [
        ...FakeHarness.UNIFORM_FILES,
        FakeHarness.INSTRUCTIONS_FILE,
        FakeHarness.STANDARDS_FILE,
      ],
      overwritten: [...this.overwrites],
    };
  }

  async sync(directory: Checkout): Promise<string[]> {
    this.syncs.push(directory);
    return [...this.changed];
  }

  async compareUniform(file: string, content: string): Promise<UniformComparison> {
    if (!(UNIFORM_FILES as readonly string[]).includes(file)) {
      return "different";
    }
    return this.comparisons.get(content) ?? "different";
  }
}
