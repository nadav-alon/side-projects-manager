import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { documentStore } from "./document-store.ts";
import {
  DEFAULT_BUDGET,
  branch,
  containerPath,
  hostPath,
  day,
  exitCode,
  issueNumber,
  issueUrl,
  keptSummaryPath,
  modelName,
  priority,
  processId,
  pullRequestUrl,
  repoSlug,
  tokenCount,
  transcriptDirectory,
} from "../ports/index.ts";

const PILOT = repoSlug("nadav-alon/pilot");
const MANAGER = repoSlug("nadav-alon/side-projects-manager");

const YESTERDAY = new Date("2025-12-31T06:00:00.000Z");

/** A manager home containing whichever documents a test writes. */
async function home(
  documents: {
    registry?: string;
    budget?: string;
    state?: string;
    models?: string;
    journal?: string;
  } = {},
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "morning-run-"));
  if (documents.models !== undefined) {
    await writeFile(path.join(directory, "models.json"), documents.models);
  }
  if (documents.registry !== undefined) {
    await writeFile(path.join(directory, "registry.json"), documents.registry);
  }
  if (documents.budget !== undefined) {
    await writeFile(path.join(directory, "budget.json"), documents.budget);
  }
  if (documents.state !== undefined) {
    await writeFile(path.join(directory, "state.json"), documents.state);
  }
  if (documents.journal !== undefined) {
    await writeFile(path.join(directory, "journal.json"), documents.journal);
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
      { repo: MANAGER, paused: false, turbo: false },
      { repo: PILOT, paused: false, turbo: false },
    ]);
  });

  it("reads the host directories a project mounts into its runs", async () => {
    const store = documentStore(
      await home({
        registry: JSON.stringify({
          projects: [
            {
              repo: PILOT,
              mounts: [{ host: "/srv/pilot/config", container: "/mnt/config" }],
            },
          ],
        }),
      }),
    );

    assert.deepEqual(await store.loadRegistry(), [
      {
        repo: PILOT,
        paused: false,
        turbo: false,
        mounts: [
          {
            host: hostPath("/srv/pilot/config"),
            container: containerPath("/mnt/config"),
          },
        ],
      },
    ]);
  });

  it("rejects a mount whose paths are not absolute, naming the field", async () => {
    for (const mount of [
      { host: "config", container: "/mnt/config" },
      { host: "/srv/config", container: "mnt/config" },
      { host: "/srv/config", container: "/" },
      { host: "/srv/config", container: "/repo" },
      { host: "/srv/config", container: "/repo/config" },
      { host: "/srv/config", container: "/discoveries" },
      { host: "/srv/config", container: "/home/node/.claude/projects" },
      { host: "/srv/config", container: "/home/node/.claude/projects/x" },
      { host: "/srv:config", container: "/mnt/config" },
      { host: "/srv/config", container: "/mnt:config" },
    ]) {
      const store = documentStore(
        await home({
          registry: JSON.stringify({ projects: [{ repo: PILOT, mounts: [mount] }] }),
        }),
      );

      await assert.rejects(store.loadRegistry(), /"host"|"container"/);
    }
  });

  it("keeps a project's mounts when the registry is saved", async () => {
    const dir = await home({});
    const store = documentStore(dir);
    const projects = [
      {
        repo: PILOT,
        paused: false,
        turbo: false,
        mounts: [
          {
            host: hostPath("/srv/pilot/config"),
            container: containerPath("/mnt/config"),
          },
        ],
      },
    ];

    await store.saveRegistry(projects);

    assert.deepEqual(await store.loadRegistry(), projects);
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
      { repo: PILOT, paused: true, turbo: false, priority: priority(2) },
    ]);
  });

  it("reads turbo, defaulting to false when absent", async () => {
    const store = documentStore(
      await home({
        registry: JSON.stringify({
          projects: [{ repo: MANAGER, turbo: true }, { repo: PILOT }],
        }),
      }),
    );

    assert.deepEqual(await store.loadRegistry(), [
      { repo: MANAGER, paused: false, turbo: true },
      { repo: PILOT, paused: false, turbo: false },
    ]);
  });

  it("rejects a turbo that is not true or false, naming the field", async () => {
    const store = documentStore(
      await home({
        registry: JSON.stringify({ projects: [{ repo: PILOT, turbo: "yes" }] }),
      }),
    );

    await assert.rejects(store.loadRegistry(), /"turbo"/);
  });

  it("reads manager, absent unless the entry says otherwise", async () => {
    const store = documentStore(
      await home({
        registry: JSON.stringify({
          projects: [{ repo: MANAGER, manager: true }, { repo: PILOT }],
        }),
      }),
    );

    assert.deepEqual(await store.loadRegistry(), [
      { repo: MANAGER, paused: false, turbo: false, manager: true },
      { repo: PILOT, paused: false, turbo: false },
    ]);
  });

  it("rejects a manager that is not true, naming the field", async () => {
    const store = documentStore(
      await home({
        registry: JSON.stringify({ projects: [{ repo: PILOT, manager: false }] }),
      }),
    );

    await assert.rejects(store.loadRegistry(), /"manager"/);
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
      { repo: MANAGER, paused: false, turbo: false },
      { repo: PILOT, paused: true, turbo: false, priority: priority(2) },
    ]);

    assert.deepEqual(await store.loadRegistry(), [
      { repo: MANAGER, paused: false, turbo: false },
      { repo: PILOT, paused: true, turbo: false, priority: priority(2) },
    ]);
  });

  it("writes a document the developer can keep hand-editing", async () => {
    const directory = await home();

    await documentStore(directory).saveRegistry([
      { repo: PILOT, paused: false, turbo: false },
      { repo: MANAGER, paused: true, turbo: true, priority: priority(1) },
    ]);

    const written = await readFile(path.join(directory, "registry.json"), "utf8");
    assert.equal(
      written,
      `${JSON.stringify(
        {
          projects: [
            { repo: PILOT },
            { repo: MANAGER, paused: true, turbo: true, priority: 1 },
          ],
        },
        undefined,
        2,
      )}\n`,
    );
  });

  it("keeps the comments-free defaults out, so an untouched project stays one line", async () => {
    const directory = await home();

    await documentStore(directory).saveRegistry([
      { repo: PILOT, paused: false, turbo: false },
    ]);

    const written = await readFile(path.join(directory, "registry.json"), "utf8");
    assert.doesNotMatch(written, /paused|turbo|priority/);
  });

  it("keeps a turbo project's flag through a full rewrite", async () => {
    const directory = await home();

    await documentStore(directory).saveRegistry([
      { repo: PILOT, paused: false, turbo: true },
    ]);

    const written = await readFile(path.join(directory, "registry.json"), "utf8");
    assert.equal(
      written,
      `${JSON.stringify({ projects: [{ repo: PILOT, turbo: true }] }, undefined, 2)}\n`,
    );
  });

  it("keeps the manager flag through a full rewrite", async () => {
    const directory = await home();

    await documentStore(directory).saveRegistry([
      { repo: MANAGER, paused: false, turbo: true, manager: true },
    ]);

    const written = await readFile(path.join(directory, "registry.json"), "utf8");
    assert.equal(
      written,
      `${JSON.stringify(
        { projects: [{ repo: MANAGER, turbo: true, manager: true }] },
        undefined,
        2,
      )}\n`,
    );
  });

  it("replaces what was registered before", async () => {
    const store = documentStore(
      await home({ registry: JSON.stringify({ projects: [{ repo: MANAGER }] }) }),
    );

    await store.saveRegistry([{ repo: PILOT, paused: false, turbo: false }]);

    assert.deepEqual(await store.loadRegistry(), [
      { repo: PILOT, paused: false, turbo: false },
    ]);
  });
});

describe("the budget document", () => {
  it("runs under the default budget when there is no document", async () => {
    const store = documentStore(await home());

    assert.deepEqual(await store.loadBudget(), DEFAULT_BUDGET);
  });

  it("reads what the developer declared", async () => {
    const store = documentStore(
      await home({
        budget: JSON.stringify({
          fiveHourAllowance: 10_000_000,
          weeklyAllowance: 100_000_000,
          reserveFraction: 0.75,
          fiveHourReserveFraction: 0.25,
          spendCeiling: 2.5,
          maxConcurrentIterations: 2,
          sizes: { S: 100_000, M: 400_000, L: 1_000_000, XL: 2_000_000 },
          unsizedCountsAs: "L",
        }),
      }),
    );

    assert.deepEqual(await store.loadBudget(), {
      fiveHourAllowance: 10_000_000,
      weeklyAllowance: 100_000_000,
      reserveFraction: 0.75,
      fiveHourReserveFraction: 0.25,
      spendCeiling: 2.5,
      maxConcurrentIterations: 2,
      sizes: { S: 100_000, M: 400_000, L: 1_000_000, XL: 2_000_000 },
      kinds: DEFAULT_BUDGET.kinds,
      unsizedCountsAs: "L",
    });
  });

  it("takes the default for anything the developer left out", async () => {
    const store = documentStore(
      await home({ budget: JSON.stringify({ reserveFraction: 0.75 }) }),
    );

    assert.deepEqual(await store.loadBudget(), {
      ...DEFAULT_BUDGET,
      reserveFraction: 0.75,
    });
  });

  /**
   * Falling back here would run the mornings against a reserve the developer
   * believes they set and the loop never read, which is the one way this
   * document can fail silently and expensively.
   */
  it("refuses a reserve fraction that is not one, rather than falling back", async () => {
    const store = documentStore(
      await home({ budget: JSON.stringify({ reserveFraction: 1 }) }),
    );

    await assert.rejects(store.loadBudget(), /reserveFraction/);
  });

  it("refuses a reserve fraction written as a percentage", async () => {
    const store = documentStore(
      await home({ budget: JSON.stringify({ reserveFraction: 50 }) }),
    );

    await assert.rejects(store.loadBudget(), /reserveFraction/);
  });

  it("refuses an allowance that is not a whole number of tokens", async () => {
    const store = documentStore(
      await home({ budget: JSON.stringify({ weeklyAllowance: "lots" }) }),
    );

    await assert.rejects(store.loadBudget(), /weeklyAllowance/);
  });

  it("refuses a spend ceiling of nothing, which no run could start under", async () => {
    const store = documentStore(
      await home({ budget: JSON.stringify({ spendCeiling: 0 }) }),
    );

    await assert.rejects(store.loadBudget(), /spendCeiling/);
  });

  it("reads a spend ceiling declared per size", async () => {
    const store = documentStore(
      await home({
        budget: JSON.stringify({
          spendCeiling: { S: 3, M: 5, L: 10, XL: 20 },
        }),
      }),
    );

    assert.deepEqual((await store.loadBudget()).spendCeiling, {
      S: 3,
      M: 5,
      L: 10,
      XL: 20,
    });
  });

  it("completes a partial per-size spend ceiling from the flat default", async () => {
    const store = documentStore(
      await home({ budget: JSON.stringify({ spendCeiling: { L: 8 } }) }),
    );

    assert.deepEqual((await store.loadBudget()).spendCeiling, {
      S: DEFAULT_BUDGET.spendCeiling,
      M: DEFAULT_BUDGET.spendCeiling,
      L: 8,
      XL: DEFAULT_BUDGET.spendCeiling,
    });
  });

  it("refuses a per-size spend ceiling of nothing, the same as the flat form", async () => {
    const store = documentStore(
      await home({ budget: JSON.stringify({ spendCeiling: { S: 0 } }) }),
    );

    await assert.rejects(store.loadBudget(), /spendCeiling\.S/);
  });

  it("refuses a per-size spend ceiling naming a size the four labels do not", async () => {
    const store = documentStore(
      await home({ budget: JSON.stringify({ spendCeiling: { XS: 3 } }) }),
    );

    await assert.rejects(store.loadBudget(), /no such size: XS/);
  });

  /**
   * Every field is optional, so a misspelling is indistinguishable from a
   * field left out — and reads as a budget the developer never set.
   */
  it("refuses a setting it does not recognise, rather than ignoring it", async () => {
    const store = documentStore(
      await home({ budget: JSON.stringify({ reserve: 0.9 }) }),
    );

    await assert.rejects(store.loadBudget(), /no such setting: reserve/);
  });

  it("names what it did expect when it refuses one", async () => {
    const store = documentStore(
      await home({ budget: JSON.stringify({ reserveFractions: 0.9 }) }),
    );

    await assert.rejects(store.loadBudget(), /reserveFraction/);
  });

  /**
   * An allowance of nothing leaves nothing spendable, and a window is let
   * through while it has consumed no more than it may — so zero would
   * authorise a run every morning rather than stopping them.
   */
  it("refuses an allowance of nothing, which would authorise rather than halt", async () => {
    const store = documentStore(
      await home({ budget: JSON.stringify({ weeklyAllowance: 0 }) }),
    );

    await assert.rejects(store.loadBudget(), /weeklyAllowance/);
  });

  it("defaults the concurrency limit to 1", async () => {
    const store = documentStore(
      await home({ budget: JSON.stringify({ reserveFraction: 0.75 }) }),
    );

    assert.equal((await store.loadBudget()).maxConcurrentIterations, 1);
  });

  it("reads a declared concurrency limit", async () => {
    const store = documentStore(
      await home({ budget: JSON.stringify({ maxConcurrentIterations: 3 }) }),
    );

    assert.deepEqual(await store.loadBudget(), {
      ...DEFAULT_BUDGET,
      maxConcurrentIterations: 3,
    });
  });

  for (const limit of [0, -1, 1.5, "3", null]) {
    it(`refuses a concurrency limit of ${JSON.stringify(limit)}`, async () => {
      const store = documentStore(
        await home({
          budget: JSON.stringify({ maxConcurrentIterations: limit }),
        }),
      );

      await assert.rejects(store.loadBudget(), /maxConcurrentIterations/);
    });
  }

  it("defaults the 5-hour reserve to nothing, so a machine that sets nothing behaves as today", async () => {
    const store = documentStore(
      await home({ budget: JSON.stringify({ reserveFraction: 0.75 }) }),
    );

    assert.equal((await store.loadBudget()).fiveHourReserveFraction, 0);
  });

  it("reads a declared 5-hour reserve", async () => {
    const store = documentStore(
      await home({
        budget: JSON.stringify({ fiveHourReserveFraction: 0.2 }),
      }),
    );

    assert.deepEqual(await store.loadBudget(), {
      ...DEFAULT_BUDGET,
      fiveHourReserveFraction: 0.2,
    });
  });

  it("refuses a 5-hour reserve that is not one, the same as the weekly reserve", async () => {
    const store = documentStore(
      await home({ budget: JSON.stringify({ fiveHourReserveFraction: 1 }) }),
    );

    await assert.rejects(store.loadBudget(), /fiveHourReserveFraction/);
  });

  it("defaults every size to the values the README documents", async () => {
    const store = documentStore(await home());

    assert.deepEqual((await store.loadBudget()).sizes, {
      S: 150_000,
      M: 600_000,
      L: 1_500_000,
      XL: 3_000_000,
    });
  });

  it("completes a partial sizes map from the defaults", async () => {
    const store = documentStore(
      await home({ budget: JSON.stringify({ sizes: { L: 6_000_000 } }) }),
    );

    assert.deepEqual((await store.loadBudget()).sizes, {
      ...DEFAULT_BUDGET.sizes,
      L: 6_000_000,
    });
  });

  it("refuses a size worth something other than a token count", async () => {
    const store = documentStore(
      await home({ budget: JSON.stringify({ sizes: { S: -1 } }) }),
    );

    await assert.rejects(store.loadBudget(), /sizes\.S/);
  });

  it("refuses a size the four labels do not name", async () => {
    const store = documentStore(
      await home({ budget: JSON.stringify({ sizes: { XS: 100_000 } }) }),
    );

    await assert.rejects(store.loadBudget(), /no such size: XS/);
  });

  it("defaults an unsized ticket to M", async () => {
    const store = documentStore(await home());

    assert.equal((await store.loadBudget()).unsizedCountsAs, "M");
  });

  it("reads a declared size for unsized tickets", async () => {
    const store = documentStore(
      await home({ budget: JSON.stringify({ unsizedCountsAs: "S" }) }),
    );

    assert.deepEqual(await store.loadBudget(), {
      ...DEFAULT_BUDGET,
      unsizedCountsAs: "S",
    });
  });

  it("refuses an unsizedCountsAs naming no size", async () => {
    const store = documentStore(
      await home({ budget: JSON.stringify({ unsizedCountsAs: "XS" }) }),
    );

    await assert.rejects(store.loadBudget(), /unsizedCountsAs/);
  });

  it("reads a figure per pull request kind, spelling apply-review as applyReview", async () => {
    const store = documentStore(
      await home({
        budget: JSON.stringify({
          kinds: { review: 250_000, applyReview: 450_000, rebase: 100_000 },
        }),
      }),
    );

    assert.deepEqual((await store.loadBudget()).kinds, {
      review: 250_000,
      applyReview: 450_000,
      rebase: 100_000,
    });
  });

  it("leaves a kind the document omits without a figure", async () => {
    const store = documentStore(
      await home({ budget: JSON.stringify({ kinds: { rebase: 100_000 } }) }),
    );

    assert.deepEqual((await store.loadBudget()).kinds, { rebase: 100_000 });
  });

  it("refuses a kind figure that is not a whole number of tokens", async () => {
    const store = documentStore(
      await home({ budget: JSON.stringify({ kinds: { rebase: -1 } }) }),
    );

    await assert.rejects(store.loadBudget(), /kinds\.rebase/);
  });

  it("refuses a kind the three pull request kinds do not name", async () => {
    const store = documentStore(
      await home({ budget: JSON.stringify({ kinds: { "apply-review": 1 } }) }),
    );

    await assert.rejects(store.loadBudget(), /no such kind: apply-review/);
  });

  it("reads an observed reset as an instant", async () => {
    const store = documentStore(
      await home({
        budget: JSON.stringify({ observedResetAt: "2026-09-12T08:00:00Z" }),
      }),
    );

    assert.deepEqual(await store.loadBudget(), {
      ...DEFAULT_BUDGET,
      observedResetAt: new Date("2026-09-12T08:00:00.000Z"),
    });
  });

  it("leaves the property off entirely when no reset was observed", async () => {
    const store = documentStore(
      await home({ budget: JSON.stringify({ reserveFraction: 0.75 }) }),
    );

    assert.ok(!("observedResetAt" in (await store.loadBudget())));
  });

  /**
   * The developer copies this off a display showing their own clock, and it
   * is compared against UTC instants from the session logs. Reading a naive
   * string as local time would be believed to the hour and wrong by the
   * offset — a worse boundary than the inference it was meant to replace.
   */
  it("refuses a timestamp with no zone rather than guessing one", async () => {
    const store = documentStore(
      await home({
        budget: JSON.stringify({ observedResetAt: "2026-09-12T08:00:00" }),
      }),
    );

    await assert.rejects(store.loadBudget(), /observedResetAt/);
  });

  it("reads a zone written as an offset from UTC", async () => {
    const store = documentStore(
      await home({
        budget: JSON.stringify({ observedResetAt: "2026-09-12T11:00:00+03:00" }),
      }),
    );

    assert.deepEqual(await store.loadBudget(), {
      ...DEFAULT_BUDGET,
      observedResetAt: new Date("2026-09-12T08:00:00.000Z"),
    });
  });

  it("refuses a reset written as anything but a string", async () => {
    const store = documentStore(
      await home({
        budget: JSON.stringify({ observedResetAt: 1_757_664_000_000 }),
      }),
    );

    await assert.rejects(store.loadBudget(), /observedResetAt/);
  });

  it("refuses a reset that is not a date at all", async () => {
    const store = documentStore(
      await home({
        budget: JSON.stringify({ observedResetAt: "this morning" }),
      }),
    );

    await assert.rejects(store.loadBudget(), /observedResetAt/);
  });

  it("survives the new-project command rewriting the registry", async () => {
    const directory = await home({
      registry: JSON.stringify({ projects: [{ repo: PILOT }] }),
      budget: JSON.stringify({ reserveFraction: 0.75 }),
    });
    const store = documentStore(directory);

    await store.saveRegistry([{ repo: MANAGER, paused: false, turbo: false }]);

    assert.equal((await store.loadBudget()).reserveFraction, 0.75);
  });
});

describe("the model defaults document", () => {
  it("has no default for any kind when there is no document", async () => {
    const store = documentStore(await home());

    assert.deepEqual(await store.loadModelDefaults(), {});
  });

  it("has no default for a kind the developer left out", async () => {
    const store = documentStore(
      await home({ models: JSON.stringify({ review: "opus" }) }),
    );

    assert.deepEqual(await store.loadModelDefaults(), {
      review: modelName("opus"),
    });
  });

  it("reads a model for each kind, as written", async () => {
    const store = documentStore(
      await home({
        models: JSON.stringify({
          implementation: "sonnet",
          review: "claude-opus-5",
          "apply-review": "sonnet",
          rebase: "opus",
          "spec-review": "fable",
          "ux-review": "fable",
        }),
      }),
    );

    assert.deepEqual(await store.loadModelDefaults(), {
      implementation: modelName("sonnet"),
      "apply-review": modelName("sonnet"),
      review: modelName("claude-opus-5"),
      rebase: modelName("opus"),
      "spec-review": modelName("fable"),
      "ux-review": modelName("fable"),
    });
  });

  it("reads fable as the checked-in default for a ux review", async () => {
    const store = documentStore(
      await home({ models: await readFile(new URL("../../models.json", import.meta.url), "utf8") }),
    );

    assert.equal((await store.loadModelDefaults())["ux-review"], modelName("fable"));
  });

  /**
   * Every kind is optional, so a misspelt kind is indistinguishable from one
   * left out — and would silently run on the image's model instead.
   */
  it("refuses a kind it does not recognise, naming the file and the key", async () => {
    const store = documentStore(
      await home({ models: JSON.stringify({ reveiw: "opus" }) }),
    );

    await assert.rejects(
      store.loadModelDefaults(),
      /models\.json: no such kind: reveiw/,
    );
  });

  for (const name of ["", " ", 4, null, ["opus"]]) {
    it(`refuses a model name of ${JSON.stringify(name)}, naming the file`, async () => {
      const store = documentStore(
        await home({ models: JSON.stringify({ review: name }) }),
      );

      await assert.rejects(store.loadModelDefaults(), /models\.json.*review/);
    });
  }

  it("refuses a document that is not an object of kinds", async () => {
    const store = documentStore(
      await home({ models: JSON.stringify(["sonnet"]) }),
    );

    await assert.rejects(store.loadModelDefaults(), /models\.json/);
  });

  it("survives the new-project command rewriting the registry", async () => {
    const directory = await home({
      models: JSON.stringify({ review: "opus" }),
    });
    const store = documentStore(directory);

    await store.saveRegistry([{ repo: MANAGER, paused: false, turbo: false }]);

    assert.deepEqual(await store.loadModelDefaults(), {
      review: modelName("opus"),
    });
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

    assert.deepEqual(state.projects.get(PILOT), {
      lastWorkedAt: YESTERDAY,
      runs: [
        { at: YESTERDAY, tokensUsed: tokenCount(120_000) },
        { at: YESTERDAY, tokensUsed: tokenCount(90_000) },
      ],
    });
  });

  it("treats a missing document as nothing ever worked", async () => {
    const store = documentStore(await home());

    assert.equal((await store.loadState()).projects.size, 0);
  });

  it("treats an empty document as nothing ever worked", async () => {
    const store = documentStore(await home({ state: "" }));

    assert.equal((await store.loadState()).projects.size, 0);
  });

  it("treats a project it has no entry for as never worked", async () => {
    const store = documentStore(
      await home({
        state: JSON.stringify({ projects: { [MANAGER]: { runs: [] } } }),
      }),
    );

    assert.equal((await store.loadState()).projects.get(PILOT), undefined);
  });

  it("reads a project that is registered but not yet worked", async () => {
    const store = documentStore(
      await home({
        state: JSON.stringify({ projects: { [PILOT]: { runs: [] } } }),
      }),
    );

    assert.deepEqual((await store.loadState()).projects.get(PILOT), { runs: [] });
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
    const state = {
      projects: new Map([
        [
          PILOT,
          {
            lastWorkedAt: YESTERDAY,
            runs: [{ at: YESTERDAY, tokensUsed: tokenCount(120_000) }],
          },
        ],
      ]),
    };

    await store.saveState(state);

    assert.deepEqual(await store.loadState(), state);
  });

  it("writes a document a developer can read in a diff", async () => {
    const directory = await home();
    const store = documentStore(directory);

    await store.saveState({
      projects: new Map([[PILOT, { lastWorkedAt: YESTERDAY, runs: [] }]]),
    });

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

    await store.saveState({
      projects: new Map([[PILOT, { lastWorkedAt: YESTERDAY, runs: [] }]]),
    });
    await store.saveState({ projects: new Map() });

    assert.equal((await store.loadState()).projects.size, 0);
  });

  it("reads a document that records no tickets worked today as none worked", async () => {
    const store = documentStore(
      await home({
        state: JSON.stringify({ projects: { [PILOT]: { runs: [] } } }),
      }),
    );

    assert.equal((await store.loadState()).workedToday, undefined);
  });

  it("survives a round trip with the tickets worked today", async () => {
    const store = documentStore(await home());
    const state = {
      projects: new Map(),
      workedToday: {
        day: day("2026-01-01"),
        tickets: [
          { repo: PILOT, number: issueNumber(7) },
          { repo: MANAGER, number: issueNumber(12) },
        ],
      },
    };

    await store.saveState(state);

    assert.deepEqual(await store.loadState(), state);
  });

  it("survives a round trip with which invocation recorded a ticket worked today", async () => {
    const store = documentStore(await home());
    const state = {
      projects: new Map(),
      workedToday: {
        day: day("2026-01-01"),
        tickets: [
          {
            repo: PILOT,
            number: issueNumber(7),
            recordedBy: {
              openedAt: new Date("2026-01-01T08:09:00.000Z"),
              process: processId(7563),
            },
          },
        ],
      },
    };

    await store.saveState(state);

    assert.deepEqual(await store.loadState(), state);
  });

  it("reads a ticket worked today that names no invocation as recorded by none", async () => {
    const store = documentStore(
      await home({
        state: JSON.stringify({
          projects: {},
          workedToday: {
            day: "2026-01-01",
            tickets: [{ repo: PILOT, number: 7 }],
          },
        }),
      }),
    );

    const { workedToday } = await store.loadState();

    assert.deepEqual(workedToday?.tickets, [{ repo: PILOT, number: issueNumber(7) }]);
  });

  it("rejects tickets worked today recorded against something that is not a day", async () => {
    const store = documentStore(
      await home({
        state: JSON.stringify({
          projects: {},
          workedToday: { day: "today", tickets: [] },
        }),
      }),
    );

    await assert.rejects(store.loadState(), /workedToday/);
  });

  it("rejects tickets worked today recorded with no list of tickets", async () => {
    const store = documentStore(
      await home({
        state: JSON.stringify({
          projects: {},
          workedToday: { day: "2026-01-01" },
        }),
      }),
    );

    await assert.rejects(store.loadState(), /"tickets" must be a list/);
  });

  it("rejects a ticket worked today that names no repo slug", async () => {
    const store = documentStore(
      await home({
        state: JSON.stringify({
          projects: {},
          workedToday: { day: "2026-01-01", tickets: [{ repo: "pilot", number: 7 }] },
        }),
      }),
    );

    await assert.rejects(store.loadState(), /workedToday/);
  });

  it("reads a document with no announcedOn as not announced", async () => {
    const store = documentStore(
      await home({
        state: JSON.stringify({ projects: {} }),
      }),
    );

    assert.equal((await store.loadState()).announcedOn, undefined);
  });

  it("survives a round trip with the day last announced", async () => {
    const store = documentStore(await home());
    const state = { projects: new Map(), announcedOn: day("2026-01-01") };

    await store.saveState(state);

    assert.deepEqual(await store.loadState(), state);
  });

  it("rejects a day last announced that is not a calendar day", async () => {
    const store = documentStore(
      await home({
        state: JSON.stringify({ projects: {}, announcedOn: "today" }),
      }),
    );

    await assert.rejects(store.loadState(), /announcedOn/);
  });

  it("reads a document with no salvages as nothing salvaged", async () => {
    const store = documentStore(
      await home({
        state: JSON.stringify({ projects: {} }),
      }),
    );

    assert.equal((await store.loadState()).salvages, undefined);
  });

  it("survives a round trip with a ticket's salvaged branch", async () => {
    const store = documentStore(await home());
    const state = {
      projects: new Map(),
      salvages: [
        {
          repo: PILOT,
          number: issueNumber(7),
          branch: branch("issue-7-salvage"),
          stopShorts: 2,
        },
      ],
    };

    await store.saveState(state);

    assert.deepEqual(await store.loadState(), state);
  });

  it("rejects a salvage that names no repo slug", async () => {
    const store = documentStore(
      await home({
        state: JSON.stringify({
          projects: {},
          salvages: [{ number: 7, branch: "issue-7-salvage", stopShorts: 1 }],
        }),
      }),
    );

    await assert.rejects(store.loadState(), /salvages/);
  });

  it("rejects a salvage whose branch is not one git would accept", async () => {
    const store = documentStore(
      await home({
        state: JSON.stringify({
          projects: {},
          salvages: [
            { repo: PILOT, number: 7, branch: "", stopShorts: 1 },
          ],
        }),
      }),
    );

    await assert.rejects(store.loadState(), /"branch" must be a git branch name/);
  });

  it("rejects a salvage whose stopShorts is negative", async () => {
    const store = documentStore(
      await home({
        state: JSON.stringify({
          projects: {},
          salvages: [
            { repo: PILOT, number: 7, branch: "issue-7-salvage", stopShorts: -1 },
          ],
        }),
      }),
    );

    await assert.rejects(store.loadState(), /"stopShorts" must be a whole number/);
  });

  it("survives a round trip with a grant record", async () => {
    const store = documentStore(await home());
    const state = {
      projects: new Map(),
      grants: [
        { repo: PILOT, number: issueNumber(7), grantedAt: new Date("2026-01-01T09:00:00.000Z") },
      ],
    };

    await store.saveState(state);

    assert.deepEqual(await store.loadState(), state);
  });

  it("reads a document with no grants as none standing", async () => {
    const store = documentStore(await home({ state: JSON.stringify({ projects: {} }) }));

    assert.equal((await store.loadState()).grants, undefined);
  });

  it("rejects a grant record with no grantedAt", async () => {
    const store = documentStore(
      await home({
        state: JSON.stringify({ projects: {}, grants: [{ repo: PILOT, number: 7 }] }),
      }),
    );

    await assert.rejects(store.loadState(), /grantedAt/);
  });

  it("reads a document with no run spans as nothing ever run", async () => {
    const store = documentStore(
      await home({
        state: JSON.stringify({ projects: {} }),
      }),
    );

    assert.equal((await store.loadState()).runSpans, undefined);
  });

  it("survives a round trip with a ticket's own run span, open", async () => {
    const store = documentStore(await home());
    const state = {
      projects: new Map(),
      runSpans: [
        {
          repo: PILOT,
          number: issueNumber(7),
          startedAt: new Date("2026-01-01T09:00:00.000Z"),
        },
      ],
    };

    await store.saveState(state);

    assert.deepEqual(await store.loadState(), state);
  });

  it("survives a round trip with a ticket's own run span, closed", async () => {
    const store = documentStore(await home());
    const state = {
      projects: new Map(),
      runSpans: [
        {
          repo: PILOT,
          number: issueNumber(7),
          startedAt: new Date("2026-01-01T09:00:00.000Z"),
          endedAt: new Date("2026-01-01T09:20:00.000Z"),
        },
      ],
    };

    await store.saveState(state);

    assert.deepEqual(await store.loadState(), state);
  });

  it("survives a round trip with a run span's opening invocation", async () => {
    const store = documentStore(await home());
    const state = {
      projects: new Map(),
      runSpans: [
        {
          repo: PILOT,
          number: issueNumber(7),
          startedAt: new Date("2026-01-01T09:00:00.000Z"),
          openedBy: {
            openedAt: new Date("2026-01-01T08:09:00.000Z"),
            process: processId(7563),
          },
        },
      ],
    };

    await store.saveState(state);

    assert.deepEqual(await store.loadState(), state);
  });

  it("reads a run span that names no opening invocation as recorded before that field existed", async () => {
    const store = documentStore(
      await home({
        state: JSON.stringify({
          projects: {},
          runSpans: [
            { repo: PILOT, number: 7, startedAt: "2026-01-01T09:00:00.000Z" },
          ],
        }),
      }),
    );

    const [span] = (await store.loadState()).runSpans ?? [];

    assert.equal(span?.openedBy, undefined);
  });

  it("rejects a run span that names no repo slug", async () => {
    const store = documentStore(
      await home({
        state: JSON.stringify({
          projects: {},
          runSpans: [
            { number: 7, startedAt: "2026-01-01T09:00:00.000Z" },
          ],
        }),
      }),
    );

    await assert.rejects(store.loadState(), /runSpans/);
  });

  it("rejects a run span whose startedAt is not a timestamp", async () => {
    const store = documentStore(
      await home({
        state: JSON.stringify({
          projects: {},
          runSpans: [
            { repo: PILOT, number: 7, startedAt: "not a date" },
          ],
        }),
      }),
    );

    await assert.rejects(store.loadState(), /"startedAt" must be an ISO 8601 timestamp/);
  });

  it("rejects a run span whose endedAt is not a timestamp", async () => {
    const store = documentStore(
      await home({
        state: JSON.stringify({
          projects: {},
          runSpans: [
            {
              repo: PILOT,
              number: 7,
              startedAt: "2026-01-01T09:00:00.000Z",
              endedAt: "not a date",
            },
          ],
        }),
      }),
    );

    await assert.rejects(store.loadState(), /"endedAt" must be an ISO 8601 timestamp/);
  });
});

describe("the journal document", () => {
  const OPENED_AT = new Date("2026-01-01T06:00:00.000Z");
  const CLOSED_AT = new Date("2026-01-01T06:10:00.000Z");
  const PROCESS = processId(4242);

  it("reads no records when the document does not exist", async () => {
    const store = documentStore(await home());

    assert.deepEqual(await store.loadJournal(), { records: [] });
  });

  it("reads no records when the document is empty", async () => {
    const store = documentStore(await home({ journal: "" }));

    assert.deepEqual(await store.loadJournal(), { records: [] });
  });

  it("rejects a document that is not valid JSON, naming the file", async () => {
    const store = documentStore(await home({ journal: "{ records: [" }));

    await assert.rejects(store.loadJournal(), /journal\.json/);
  });

  it("appends an in-flight record when opened, with no closing fields", async () => {
    const store = documentStore(await home());

    await store.openInvocation({ openedAt: OPENED_AT, process: PROCESS });

    assert.deepEqual(await store.loadJournal(), {
      records: [{ openedAt: OPENED_AT, process: PROCESS }],
    });
  });

  it("returns whatever closing the record later needs", async () => {
    const store = documentStore(await home());

    const opened = await store.openInvocation({
      openedAt: OPENED_AT,
      process: PROCESS,
    });

    assert.deepEqual(opened, { openedAt: OPENED_AT, process: PROCESS });
  });

  it("closes an open record with what the invocation came to", async () => {
    const store = documentStore(await home());
    const opened = await store.openInvocation({
      openedAt: OPENED_AT,
      process: PROCESS,
    });

    await store.closeInvocation(opened, {
      closedAt: CLOSED_AT,
      outcome: "work-selected",
      projects: [{ repo: PILOT, tokensUsed: tokenCount(1_000) }],
    });

    assert.deepEqual(await store.loadJournal(), {
      records: [
        {
          openedAt: OPENED_AT,
          process: PROCESS,
          closedAt: CLOSED_AT,
          outcome: "work-selected",
          projects: [{ repo: PILOT, tokensUsed: tokenCount(1_000) }],
        },
      ],
    });
  });

  it("records a stand-down reason when the invocation stood down", async () => {
    const store = documentStore(await home());
    const opened = await store.openInvocation({
      openedAt: OPENED_AT,
      process: PROCESS,
    });

    await store.closeInvocation(opened, {
      closedAt: CLOSED_AT,
      outcome: "stood-down",
      projects: [],
      standDownReason: "weekly-reserve: 250000000 of 250000000 tokens used",
    });

    const [record] = (await store.loadJournal()).records;
    assert.equal(
      record?.standDownReason,
      "weekly-reserve: 250000000 of 250000000 tokens used",
    );
  });

  it("records an exit code when the invocation never reported", async () => {
    const store = documentStore(await home());
    const opened = await store.openInvocation({
      openedAt: OPENED_AT,
      process: PROCESS,
    });

    await store.closeInvocation(opened, {
      closedAt: CLOSED_AT,
      outcome: "never-reported",
      projects: [],
      exitCode: exitCode(7),
    });

    const [record] = (await store.loadJournal()).records;
    assert.equal(record?.outcome, "never-reported");
    assert.equal(record?.exitCode, 7);
  });

  it("records where a published summary landed", async () => {
    const store = documentStore(await home());
    const opened = await store.openInvocation({
      openedAt: OPENED_AT,
      process: PROCESS,
    });

    await store.closeInvocation(opened, {
      closedAt: CLOSED_AT,
      outcome: "dry-queue",
      projects: [],
      summaryLocation: issueUrl(
        "https://github.com/nadav-alon/side-projects-manager/issues/1",
      ),
    });

    const [record] = (await store.loadJournal()).records;
    assert.equal(
      record?.summaryLocation,
      "https://github.com/nadav-alon/side-projects-manager/issues/1",
    );
  });

  it("records why a summary failed to publish, and where its text was kept", async () => {
    const store = documentStore(await home());
    const opened = await store.openInvocation({
      openedAt: OPENED_AT,
      process: PROCESS,
    });

    await store.closeInvocation(opened, {
      closedAt: CLOSED_AT,
      outcome: "dry-queue",
      projects: [],
      summaryFailure: {
        reason: "rate limited",
        keptAt: keptSummaryPath("/home/summary.txt"),
      },
    });

    const [record] = (await store.loadJournal()).records;
    assert.deepEqual(record?.summaryFailure, {
      reason: "rate limited",
      keptAt: "/home/summary.txt",
    });
  });

  it("records a summary failure with no keptAt, when even that write failed", async () => {
    const store = documentStore(await home());
    const opened = await store.openInvocation({
      openedAt: OPENED_AT,
      process: PROCESS,
    });

    await store.closeInvocation(opened, {
      closedAt: CLOSED_AT,
      outcome: "dry-queue",
      projects: [],
      summaryFailure: { reason: "rate limited" },
    });

    const [record] = (await store.loadJournal()).records;
    assert.deepEqual(record?.summaryFailure, { reason: "rate limited" });
  });

  it("rejects a record naming a summaryLocation that is not an issue URL", async () => {
    const store = documentStore(
      await home({
        journal: JSON.stringify({
          records: [
            {
              openedAt: OPENED_AT.toISOString(),
              process: 4242,
              closedAt: CLOSED_AT.toISOString(),
              outcome: "dry-queue",
              projects: [],
              summaryLocation: "not a url",
            },
          ],
        }),
      }),
    );

    await assert.rejects(store.loadJournal(), /"summaryLocation"/);
  });

  it("rejects a record naming a keptAt that is not an absolute path", async () => {
    const store = documentStore(
      await home({
        journal: JSON.stringify({
          records: [
            {
              openedAt: OPENED_AT.toISOString(),
              process: 4242,
              closedAt: CLOSED_AT.toISOString(),
              outcome: "dry-queue",
              projects: [],
              summaryFailure: { reason: "rate limited", keptAt: "relative.txt" },
            },
          ],
        }),
      }),
    );

    await assert.rejects(store.loadJournal(), /"keptAt"/);
  });

  it("rejects a record whose summaryFailure names no reason", async () => {
    const store = documentStore(
      await home({
        journal: JSON.stringify({
          records: [
            {
              openedAt: OPENED_AT.toISOString(),
              process: 4242,
              closedAt: CLOSED_AT.toISOString(),
              outcome: "dry-queue",
              projects: [],
              summaryFailure: {},
            },
          ],
        }),
      }),
    );

    await assert.rejects(store.loadJournal(), /"summaryFailure": "reason"/);
  });

  it("rejects closing a record that was never opened", async () => {
    const store = documentStore(await home());

    await assert.rejects(
      store.closeInvocation(
        { openedAt: OPENED_AT, process: PROCESS },
        { closedAt: CLOSED_AT, outcome: "dry-queue", projects: [] },
      ),
      /no invocation record opened/,
    );
  });

  it("rejects closing a record that is already closed", async () => {
    const store = documentStore(await home());
    const opened = await store.openInvocation({
      openedAt: OPENED_AT,
      process: PROCESS,
    });
    await store.closeInvocation(opened, {
      closedAt: CLOSED_AT,
      outcome: "dry-queue",
      projects: [],
    });

    await assert.rejects(
      store.closeInvocation(opened, {
        closedAt: CLOSED_AT,
        outcome: "dry-queue",
        projects: [],
      }),
      /already closed/,
    );
  });

  it("keeps a record in flight until it is closed", async () => {
    const store = documentStore(await home());
    await store.openInvocation({ openedAt: OPENED_AT, process: PROCESS });

    const [record] = (await store.loadJournal()).records;

    assert.equal(record?.closedAt, undefined);
  });

  it("keeps only the most recent records, oldest dropped first", async () => {
    const store = documentStore(await home());
    for (let i = 0; i < 55; i += 1) {
      const openedAt = new Date(OPENED_AT.getTime() + i * 1_000);
      await store.openInvocation({ openedAt, process: PROCESS });
    }

    const journal = await store.loadJournal();

    assert.equal(journal.records.length, 50);
    assert.deepEqual(
      journal.records[0]?.openedAt,
      new Date(OPENED_AT.getTime() + 5_000),
    );
    assert.deepEqual(
      journal.records[49]?.openedAt,
      new Date(OPENED_AT.getTime() + 54_000),
    );
  });

  it("rejects a record naming a process that is not a whole number above 0", async () => {
    const store = documentStore(
      await home({
        journal: JSON.stringify({
          records: [{ openedAt: OPENED_AT.toISOString(), process: 0 }],
        }),
      }),
    );

    await assert.rejects(store.loadJournal(), /"process"/);
  });

  it("rejects a record naming an outcome the loop does not report", async () => {
    const store = documentStore(
      await home({
        journal: JSON.stringify({
          records: [
            {
              openedAt: OPENED_AT.toISOString(),
              process: 4242,
              closedAt: CLOSED_AT.toISOString(),
              outcome: "something-else",
              projects: [],
            },
          ],
        }),
      }),
    );

    await assert.rejects(store.loadJournal(), /"outcome"/);
  });

  it("rejects a record naming an exit code outside 0 to 255", async () => {
    const store = documentStore(
      await home({
        journal: JSON.stringify({
          records: [
            {
              openedAt: OPENED_AT.toISOString(),
              process: 4242,
              closedAt: CLOSED_AT.toISOString(),
              outcome: "never-reported",
              projects: [],
              exitCode: 256,
            },
          ],
        }),
      }),
    );

    await assert.rejects(store.loadJournal(), /"exitCode"/);
  });

  it("rejects a field it does not recognise, naming the file", async () => {
    const store = documentStore(
      await home({
        journal: JSON.stringify({
          records: [{ openedAt: OPENED_AT.toISOString(), process: 4242, extra: true }],
        }),
      }),
    );

    await assert.rejects(store.loadJournal(), /no such field: extra/);
  });

  it("survives a round trip through the document, closed record included", async () => {
    const store = documentStore(await home());
    const opened = await store.openInvocation({
      openedAt: OPENED_AT,
      process: PROCESS,
    });
    await store.closeInvocation(opened, {
      closedAt: CLOSED_AT,
      outcome: "work-selected",
      projects: [{ repo: PILOT, tokensUsed: tokenCount(1_000) }],
    });

    assert.deepEqual(await store.loadJournal(), {
      records: [
        {
          openedAt: OPENED_AT,
          process: PROCESS,
          closedAt: CLOSED_AT,
          outcome: "work-selected",
          projects: [{ repo: PILOT, tokensUsed: tokenCount(1_000) }],
        },
      ],
    });
  });

  it("writes a document a developer can read in a diff", async () => {
    const directory = await home();
    const store = documentStore(directory);
    const opened = await store.openInvocation({
      openedAt: OPENED_AT,
      process: PROCESS,
    });
    await store.closeInvocation(opened, {
      closedAt: CLOSED_AT,
      outcome: "dry-queue",
      projects: [],
    });

    const written = await readFile(path.join(directory, "journal.json"), "utf8");
    assert.equal(
      written,
      `${JSON.stringify(
        {
          records: [
            {
              openedAt: OPENED_AT.toISOString(),
              process: 4242,
              closedAt: CLOSED_AT.toISOString(),
              outcome: "dry-queue",
              projects: [],
            },
          ],
        },
        undefined,
        2,
      )}\n`,
    );
  });
});

describe("runs in progress on the journal document", () => {
  const OPENED_AT = new Date("2026-01-01T06:00:00.000Z");
  const STARTED_AT = new Date("2026-01-01T06:05:00.000Z");
  const PROCESS = processId(4242);
  const TRANSCRIPT = transcriptDirectory("/home/dev/side-projects-manager/transcripts/review-abc123");
  const PULL_REQUEST = pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12");

  it("adds a run to the invocation's own open record", async () => {
    const store = documentStore(await home());
    const opened = await store.openInvocation({ openedAt: OPENED_AT, process: PROCESS });

    await store.recordRunStarted(opened, {
      kind: "review",
      repo: PILOT,
      number: issueNumber(7),
      startedAt: STARTED_AT,
      transcriptDirectory: TRANSCRIPT,
    });

    assert.deepEqual(await store.loadJournal(), {
      records: [
        {
          openedAt: OPENED_AT,
          process: PROCESS,
          runs: [
            {
              kind: "review",
              repo: PILOT,
              number: issueNumber(7),
              startedAt: STARTED_AT,
              transcriptDirectory: TRANSCRIPT,
            },
          ],
        },
      ],
    });
  });

  it("carries a review, apply-review or rebase run's own pull request through a write/read round trip", async () => {
    const store = documentStore(await home());
    const opened = await store.openInvocation({ openedAt: OPENED_AT, process: PROCESS });

    await store.recordRunStarted(opened, {
      kind: "review",
      repo: PILOT,
      number: issueNumber(7),
      startedAt: STARTED_AT,
      transcriptDirectory: TRANSCRIPT,
      pullRequest: PULL_REQUEST,
    });

    const [record] = (await store.loadJournal()).records;
    assert.deepEqual(record?.runs, [
      {
        kind: "review",
        repo: PILOT,
        number: issueNumber(7),
        startedAt: STARTED_AT,
        transcriptDirectory: TRANSCRIPT,
        pullRequest: PULL_REQUEST,
      },
    ]);
  });

  it("parses an older journal's run with no pull request field", async () => {
    const store = documentStore(
      await home({
        journal: JSON.stringify({
          records: [
            {
              openedAt: OPENED_AT.toISOString(),
              process: 4242,
              runs: [
                {
                  kind: "review",
                  repo: PILOT,
                  number: 7,
                  startedAt: STARTED_AT.toISOString(),
                  transcriptDirectory: TRANSCRIPT,
                },
              ],
            },
          ],
        }),
      }),
    );

    const [record] = (await store.loadJournal()).records;
    assert.deepEqual(record?.runs, [
      {
        kind: "review",
        repo: PILOT,
        number: issueNumber(7),
        startedAt: STARTED_AT,
        transcriptDirectory: TRANSCRIPT,
      },
    ]);
  });

  it("rejects a run whose pull request is not a pull request URL", async () => {
    const store = documentStore(
      await home({
        journal: JSON.stringify({
          records: [
            {
              openedAt: OPENED_AT.toISOString(),
              process: 4242,
              runs: [
                {
                  kind: "review",
                  repo: PILOT,
                  number: 7,
                  startedAt: STARTED_AT.toISOString(),
                  transcriptDirectory: TRANSCRIPT,
                  pullRequest: "not a pull request url",
                },
              ],
            },
          ],
        }),
      }),
    );

    await assert.rejects(store.loadJournal(), /"pullRequest" must be a pull request URL/);
  });
  it("replaces a run's progress, keeps it through a write/read round trip, and drops it when the run ends", async () => {
    const store = documentStore(await home());
    const opened = await store.openInvocation({ openedAt: OPENED_AT, process: PROCESS });
    await store.recordRunStarted(opened, {
      kind: "review",
      repo: PILOT,
      number: issueNumber(7),
      startedAt: STARTED_AT,
      transcriptDirectory: TRANSCRIPT,
    });
    const progress = {
      toolCalls: 3,
      lastTool: { name: "Bash", at: new Date("2026-01-01T06:06:00.000Z") },
      lastEventAt: new Date("2026-01-01T06:07:00.000Z"),
    };

    await store.recordRunProgress(opened, PILOT, issueNumber(7), { toolCalls: 1, lastEventAt: STARTED_AT });
    await store.recordRunProgress(opened, PILOT, issueNumber(7), progress);

    assert.deepEqual((await store.loadJournal()).records[0]?.runs?.[0]?.progress, progress);

    await store.recordRunEnded(opened, PILOT, issueNumber(7));
    await store.recordRunProgress(opened, PILOT, issueNumber(7), progress);
    assert.equal((await store.loadJournal()).records[0]?.runs?.length ?? 0, 0);
  });


  it("keeps every run going at once, in the order they started", async () => {
    const store = documentStore(await home());
    const opened = await store.openInvocation({ openedAt: OPENED_AT, process: PROCESS });

    await store.recordRunStarted(opened, {
      kind: "review",
      repo: PILOT,
      number: issueNumber(7),
      startedAt: STARTED_AT,
      transcriptDirectory: TRANSCRIPT,
    });
    await store.recordRunStarted(opened, {
      kind: "rebase",
      repo: MANAGER,
      number: issueNumber(9),
      startedAt: STARTED_AT,
      transcriptDirectory: TRANSCRIPT,
    });

    const [record] = (await store.loadJournal()).records;
    assert.deepEqual(
      record?.runs?.map((run) => run.number),
      [issueNumber(7), issueNumber(9)],
    );
  });

  it("rejects starting a run against an invocation that was never opened", async () => {
    const store = documentStore(await home());

    await assert.rejects(
      store.recordRunStarted(
        { openedAt: OPENED_AT, process: PROCESS },
        {
          kind: "review",
          repo: PILOT,
          number: issueNumber(7),
          startedAt: STARTED_AT,
          transcriptDirectory: TRANSCRIPT,
        },
      ),
      /no invocation record opened/,
    );
  });

  it("clears a run once it ends", async () => {
    const store = documentStore(await home());
    const opened = await store.openInvocation({ openedAt: OPENED_AT, process: PROCESS });
    await store.recordRunStarted(opened, {
      kind: "review",
      repo: PILOT,
      number: issueNumber(7),
      startedAt: STARTED_AT,
      transcriptDirectory: TRANSCRIPT,
    });

    await store.recordRunEnded(opened, PILOT, issueNumber(7));

    const [record] = (await store.loadJournal()).records;
    assert.equal(record?.runs, undefined);
  });

  it("clears a run left on the record when the invocation closes, rather than leaving it stale", async () => {
    const store = documentStore(await home());
    const opened = await store.openInvocation({ openedAt: OPENED_AT, process: PROCESS });
    await store.recordRunStarted(opened, {
      kind: "review",
      repo: PILOT,
      number: issueNumber(7),
      startedAt: STARTED_AT,
      transcriptDirectory: TRANSCRIPT,
    });

    await store.closeInvocation(opened, {
      closedAt: STARTED_AT,
      outcome: "invocation-failed",
      projects: [],
    });

    const [record] = (await store.loadJournal()).records;
    assert.equal(record?.runs, undefined);
  });

  it("does nothing clearing a run that was never recorded", async () => {
    const store = documentStore(await home());
    const opened = await store.openInvocation({ openedAt: OPENED_AT, process: PROCESS });

    await store.recordRunEnded(opened, PILOT, issueNumber(7));

    assert.deepEqual((await store.loadJournal()).records, [
      { openedAt: OPENED_AT, process: PROCESS },
    ]);
  });

  it("loads an existing journal with no runs field the same as one with none going", async () => {
    const store = documentStore(
      await home({
        journal: JSON.stringify({
          records: [{ openedAt: OPENED_AT.toISOString(), process: 4242 }],
        }),
      }),
    );

    const [record] = (await store.loadJournal()).records;
    assert.equal(record?.runs, undefined);
  });

  it("writes a document a developer can read in a diff, runs included", async () => {
    const directory = await home();
    const store = documentStore(directory);
    const opened = await store.openInvocation({ openedAt: OPENED_AT, process: PROCESS });
    await store.recordRunStarted(opened, {
      kind: "review",
      repo: PILOT,
      number: issueNumber(7),
      startedAt: STARTED_AT,
      transcriptDirectory: TRANSCRIPT,
    });

    const written = await readFile(path.join(directory, "journal.json"), "utf8");
    assert.equal(
      written,
      `${JSON.stringify(
        {
          records: [
            {
              openedAt: OPENED_AT.toISOString(),
              process: 4242,
              runs: [
                {
                  kind: "review",
                  repo: PILOT,
                  number: 7,
                  startedAt: STARTED_AT.toISOString(),
                  transcriptDirectory: TRANSCRIPT,
                },
              ],
            },
          ],
        },
        undefined,
        2,
      )}\n`,
    );
  });
});

describe("keeping a summary that could not be published", () => {
  const STARTED_AT = new Date("2026-01-01T08:00:00.000Z");

  it("writes the body into the manager home and answers with where it landed", async () => {
    const directory = await home();
    const store = documentStore(directory);

    const at = await store.keepSummary(STARTED_AT, "Nothing to do.");

    assert.equal(await readFile(at, "utf8"), "Nothing to do.");
    assert.equal(path.dirname(at), directory);
  });

  it("leaves the previous document intact when the write is interrupted", async () => {
    const directory = await home();
    const store = documentStore(directory);
    // The write goes through `<pending>` and a rename, the same as every
    // other manager-home document: a directory sitting at the pending path
    // forces the write to fail without leaving a half-written file behind.
    await mkdir(path.join(directory, "summary.txt.pending"));

    await assert.rejects(store.keepSummary(STARTED_AT, "Nothing to do."));

    assert.deepEqual(await readdir(directory), ["summary.txt.pending"]);
  });

  it("keeps only the most recent kept summaries, oldest deleted first", async () => {
    const directory = await home();
    const store = documentStore(directory);

    for (let i = 0; i < 22; i += 1) {
      await store.keepSummary(
        new Date(STARTED_AT.getTime() + i * 60_000),
        `Attempt ${i}.`,
      );
    }

    const kept = (await readdir(directory)).filter((entry) =>
      /^summary-.*\.txt$/.test(entry),
    );
    assert.equal(kept.length, 20);
    assert.deepEqual(kept, [...kept].sort());
  });
});
