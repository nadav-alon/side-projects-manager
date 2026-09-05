import type { NewProjectPorts } from "../new-project.ts";
import { FakeGrilling } from "./fake-grilling.ts";
import { FakeHarness } from "./fake-harness.ts";
import { FakeRepoHost } from "./fake-repo-host.ts";
import { FakeStore } from "./fake-store.ts";

/** The four fakes, typed concretely so tests can both inject and inspect them. */
export interface FakeNewProjectPorts extends NewProjectPorts {
  host: FakeRepoHost;
  harness: FakeHarness;
  grilling: FakeGrilling;
  store: FakeStore;
}

/**
 * A machine on which nothing exists yet: no repos on the host, no clones, no
 * registered projects. Tests arrange from here by putting things into the
 * fakes.
 */
export function fakeNewProjectPorts(): FakeNewProjectPorts {
  return {
    host: new FakeRepoHost(),
    harness: new FakeHarness(),
    grilling: new FakeGrilling(),
    store: new FakeStore(),
  };
}
