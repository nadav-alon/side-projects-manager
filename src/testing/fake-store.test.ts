import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  exitCode,
  issueNumber,
  modelName,
  processId,
  repoSlug,
  tokenCount,
  transcriptDirectory,
} from "../ports/index.ts";
import { FakeStore } from "./fake-store.ts";

const PILOT = repoSlug("nadav-alon/pilot");

describe("FakeStore model defaults", () => {
  it("has no default for any kind until a test names one", async () => {
    assert.deepEqual(await new FakeStore().loadModelDefaults(), {});
  });

  it("reads back the model defaults a test gave it", async () => {
    const store = new FakeStore();
    store.modelDefaults = { review: modelName("opus") };

    assert.deepEqual(await store.loadModelDefaults(), {
      review: modelName("opus"),
    });
  });
});

describe("FakeStore journal", () => {
  const OPENED_AT = new Date("2026-01-01T06:00:00.000Z");
  const CLOSED_AT = new Date("2026-01-01T06:10:00.000Z");
  const PROCESS = processId(4242);

  it("has no records until a test opens one", async () => {
    assert.deepEqual(await new FakeStore().loadJournal(), { records: [] });
  });

  it("appends an in-flight record when opened", async () => {
    const store = new FakeStore();

    await store.openInvocation({ openedAt: OPENED_AT, process: PROCESS });

    assert.deepEqual(await store.loadJournal(), {
      records: [{ openedAt: OPENED_AT, process: PROCESS }],
    });
  });

  it("closes an open record with what the invocation came to", async () => {
    const store = new FakeStore();
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

  it("records an exit code when the invocation never reported", async () => {
    const store = new FakeStore();
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

  it("rejects closing a record that was never opened", async () => {
    const store = new FakeStore();

    await assert.rejects(
      store.closeInvocation(
        { openedAt: OPENED_AT, process: PROCESS },
        { closedAt: CLOSED_AT, outcome: "dry-queue", projects: [] },
      ),
      /no invocation record opened/,
    );
  });

  it("rejects closing a record that is already closed", async () => {
    const store = new FakeStore();
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

  it("adds and clears a run in progress on the open record", async () => {
    const store = new FakeStore();
    const opened = await store.openInvocation({
      openedAt: OPENED_AT,
      process: PROCESS,
    });
    const run = {
      kind: "review" as const,
      repo: PILOT,
      number: issueNumber(7),
      startedAt: OPENED_AT,
      transcriptDirectory: transcriptDirectory("/home/dev/transcripts/review-abc"),
    };

    await store.recordRunStarted(opened, run);
    assert.deepEqual((await store.loadJournal()).records[0]?.runs, [run]);

    await store.recordRunEnded(opened, PILOT, issueNumber(7));
    assert.deepEqual((await store.loadJournal()).records[0]?.runs, []);
  });

  it("rejects starting a run against an invocation that was never opened", async () => {
    const store = new FakeStore();

    await assert.rejects(
      store.recordRunStarted(
        { openedAt: OPENED_AT, process: PROCESS },
        {
          kind: "review",
          repo: PILOT,
          number: issueNumber(7),
          startedAt: OPENED_AT,
          transcriptDirectory: transcriptDirectory("/home/dev/transcripts/review-abc"),
        },
      ),
      /no invocation record opened/,
    );
  });

  it("keeps only the most recent 50 records, oldest dropped first", async () => {
    const store = new FakeStore();
    for (let i = 0; i < 55; i += 1) {
      await store.openInvocation({
        openedAt: new Date(OPENED_AT.getTime() + i * 1_000),
        process: PROCESS,
      });
    }

    const journal = await store.loadJournal();

    assert.equal(journal.records.length, 50);
    assert.deepEqual(
      journal.records[0]?.openedAt,
      new Date(OPENED_AT.getTime() + 5_000),
    );
  });
});
