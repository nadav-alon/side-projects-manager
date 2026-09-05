import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { documentStore } from "./document-store.ts";
import { priority, repoSlug, tokenCount } from "../ports/index.ts";

const PILOT = repoSlug("nadav-alon/pilot");
const MANAGER = repoSlug("nadav-alon/side-projects-manager");

const YESTERDAY = new Date("2025-12-31T06:00:00.000Z");

/** A manager home containing whichever of the two documents a test writes. */
async function home(
  documents: { registry?: string; state?: string } = {},
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "morning-run-"));
  if (documents.registry !== undefined) {
    await writeFile(path.join(directory, "registry.json"), documents.registry);
  }
  if (documents.state !== undefined) {
    await writeFile(path.join(directory, "state.json"), documents.state);
  }
  return directory;
}

describe("the registry document", () => {
  it("reads the projects the developer registered, in the order listed", async () => {
    const store = documentStore(
      await home({
        registry: JSON.stringify({
          projects: [{ repo: MANAGER }, { repo: PILOT }],
        }),
      }),
    );

    assert.deepEqual(await store.loadRegistry(), [
      { repo: MANAGER, paused: false },
      { repo: PILOT, paused: false },
    ]);
  });

  it("reads paused and an explicit priority", async () => {
    const store = documentStore(
      await home({
        registry: JSON.stringify({
          projects: [{ repo: PILOT, paused: true, priority: 2 }],
        }),
      }),
    );

    assert.deepEqual(await store.loadRegistry(), [
      { repo: PILOT, paused: true, priority: priority(2) },
    ]);
  });

  it("registers nothing when the document does not exist", async () => {
    const store = documentStore(await home());

    assert.deepEqual(await store.loadRegistry(), []);
  });

  it("rejects a name that is not a repo slug, naming the offending value", async () => {
    const store = documentStore(
      await home({ registry: JSON.stringify({ projects: [{ repo: "pilot" }] }) }),
    );

    await assert.rejects(store.loadRegistry(), /"pilot"/);
  });

  it("rejects a priority that is not a whole number of 1 or more", async () => {
    const store = documentStore(
      await home({
        registry: JSON.stringify({ projects: [{ repo: PILOT, priority: 0 }] }),
      }),
    );

    await assert.rejects(store.loadRegistry(), /priority/);
  });

  it("rejects the same project registered twice", async () => {
    const store = documentStore(
      await home({
        registry: JSON.stringify({
          projects: [{ repo: PILOT }, { repo: PILOT, paused: true }],
        }),
      }),
    );

    await assert.rejects(store.loadRegistry(), /already registered/);
  });

  it("rejects a document that is not valid JSON, naming the file", async () => {
    const store = documentStore(await home({ registry: "{ projects: [" }));

    await assert.rejects(store.loadRegistry(), /registry\.json/);
  });
});

describe("writing the registry document", () => {
  it("reads back the projects it was given, in the order given", async () => {
    const store = documentStore(await home());

    await store.saveRegistry([
      { repo: MANAGER, paused: false },
      { repo: PILOT, paused: true, priority: priority(2) },
    ]);

    assert.deepEqual(await store.loadRegistry(), [
      { repo: MANAGER, paused: false },
      { repo: PILOT, paused: true, priority: priority(2) },
    ]);
  });

  it("writes a document the developer can keep hand-editing", async () => {
    const directory = await home();

    await documentStore(directory).saveRegistry([
      { repo: PILOT, paused: false },
      { repo: MANAGER, paused: true, priority: priority(1) },
    ]);

    const written = await readFile(path.join(directory, "registry.json"), "utf8");
    assert.equal(
      written,
      `${JSON.stringify(
        {
          projects: [
            { repo: PILOT },
            { repo: MANAGER, paused: true, priority: 1 },
          ],
        },
        undefined,
        2,
      )}\n`,
    );
  });

  it("keeps the comments-free defaults out, so an untouched project stays one line", async () => {
    const directory = await home();

    await documentStore(directory).saveRegistry([{ repo: PILOT, paused: false }]);

    const written = await readFile(path.join(directory, "registry.json"), "utf8");
    assert.doesNotMatch(written, /paused|priority/);
  });

  it("replaces what was registered before", async () => {
    const store = documentStore(
      await home({ registry: JSON.stringify({ projects: [{ repo: MANAGER }] }) }),
    );

    await store.saveRegistry([{ repo: PILOT, paused: false }]);

    assert.deepEqual(await store.loadRegistry(), [{ repo: PILOT, paused: false }]);
  });
});

describe("the state document", () => {
  it("reads when each project was last worked, and what its runs cost", async () => {
    const store = documentStore(
      await home({
        state: JSON.stringify({
          projects: {
            [PILOT]: {
              lastWorkedAt: YESTERDAY.toISOString(),
              runs: [
                { at: YESTERDAY.toISOString(), tokensUsed: 120_000 },
                { at: YESTERDAY.toISOString(), tokensUsed: 90_000 },
              ],
            },
          },
        }),
      }),
    );

    const state = await store.loadState();

    assert.deepEqual(state.get(PILOT), {
      lastWorkedAt: YESTERDAY,
      runs: [
        { at: YESTERDAY, tokensUsed: tokenCount(120_000) },
        { at: YESTERDAY, tokensUsed: tokenCount(90_000) },
      ],
    });
  });

  it("treats a missing document as nothing ever worked", async () => {
    const store = documentStore(await home());

    assert.equal((await store.loadState()).size, 0);
  });

  it("treats an empty document as nothing ever worked", async () => {
    const store = documentStore(await home({ state: "" }));

    assert.equal((await store.loadState()).size, 0);
  });

  it("treats a project it has no entry for as never worked", async () => {
    const store = documentStore(
      await home({
        state: JSON.stringify({ projects: { [MANAGER]: { runs: [] } } }),
      }),
    );

    assert.equal((await store.loadState()).get(PILOT), undefined);
  });

  it("reads a project that is registered but not yet worked", async () => {
    const store = documentStore(
      await home({
        state: JSON.stringify({ projects: { [PILOT]: { runs: [] } } }),
      }),
    );

    assert.deepEqual((await store.loadState()).get(PILOT), { runs: [] });
  });

  it("rejects a timestamp that is not a date", async () => {
    const store = documentStore(
      await home({
        state: JSON.stringify({
          projects: { [PILOT]: { lastWorkedAt: "yesterday", runs: [] } },
        }),
      }),
    );

    await assert.rejects(store.loadState(), /lastWorkedAt/);
  });

  it("survives a round trip through the document", async () => {
    const store = documentStore(await home());
    const state = new Map([
      [
        PILOT,
        {
          lastWorkedAt: YESTERDAY,
          runs: [{ at: YESTERDAY, tokensUsed: tokenCount(120_000) }],
        },
      ],
    ]);

    await store.saveState(state);

    assert.deepEqual(await store.loadState(), state);
  });

  it("writes a document a developer can read in a diff", async () => {
    const directory = await home();
    const store = documentStore(directory);

    await store.saveState(
      new Map([[PILOT, { lastWorkedAt: YESTERDAY, runs: [] }]]),
    );

    const written = await readFile(path.join(directory, "state.json"), "utf8");
    assert.equal(
      written,
      `${JSON.stringify(
        {
          projects: {
            [PILOT]: { lastWorkedAt: YESTERDAY.toISOString(), runs: [] },
          },
        },
        undefined,
        2,
      )}\n`,
    );
  });

  it("replaces what an earlier invocation wrote", async () => {
    const store = documentStore(await home());

    await store.saveState(new Map([[PILOT, { lastWorkedAt: YESTERDAY, runs: [] }]]));
    await store.saveState(new Map());

    assert.equal((await store.loadState()).size, 0);
  });
});
