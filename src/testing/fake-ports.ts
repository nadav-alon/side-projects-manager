import { noOpProgress } from "../adapters/no-op-progress.ts";
import type { MorningLoopPorts } from "../morning-run.ts";
import { FakeClock } from "./fake-clock.ts";
import { FakeHarness } from "./fake-harness.ts";
import { FakeIssueTracker } from "./fake-issue-tracker.ts";
import { FakeRepoHost } from "./fake-repo-host.ts";
import { FakeSandbox } from "./fake-sandbox.ts";
import { FakeStore } from "./fake-store.ts";
import { FakeUsageLedger } from "./fake-usage-ledger.ts";

/** The seven fakes, typed concretely so tests can both inject and inspect them. */
export interface FakePorts extends MorningLoopPorts {
  tracker: FakeIssueTracker;
  repoHost: FakeRepoHost;
  sandbox: FakeSandbox;
  ledger: FakeUsageLedger;
  clock: FakeClock;
  store: FakeStore;
  harness: FakeHarness;
}

/**
 * A whole world with nothing in it: no registered projects, no backlogs, no
 * usage. Tests arrange from here by putting things into the fakes.
 *
 * `progress` defaults to the no-op adapter, not a fake that could be
 * inspected: almost no test cares what an invocation narrated. A test that
 * does care overrides it with `FakeProgress`.
 *
 * `harness` defaults to a `FakeHarness` reporting nothing stale, so the
 * uniform sync sweep the loop runs finds nothing to propose unless a test
 * says otherwise.
 */
export function fakePorts(): FakePorts {
  return {
    tracker: new FakeIssueTracker(),
    repoHost: new FakeRepoHost(),
    sandbox: new FakeSandbox(),
    ledger: new FakeUsageLedger(),
    clock: new FakeClock(),
    store: new FakeStore(),
    harness: new FakeHarness(),
    progress: noOpProgress,
  };
}
