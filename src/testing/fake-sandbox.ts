import type {
  Sandbox,
  SandboxRunRequest,
  SandboxRunResult,
} from "../ports/index.ts";

/**
 * Records every run it was asked for. Tests assert on `runs` — including
 * asserting it stayed empty, which is how "the loop did no work" is checked.
 */
export class FakeSandbox implements Sandbox {
  readonly runs: SandboxRunRequest[] = [];
  #result: SandboxRunResult = {
    branch: "fake-branch",
    commits: [],
    output: "",
    tokensUsed: 0,
  };

  /** Sets what the next runs return. */
  willReturn(result: Partial<SandboxRunResult>): void {
    this.#result = { ...this.#result, ...result };
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    this.runs.push(request);
    return { ...this.#result };
  }
}
