import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { writeFile } from "node:fs/promises";

import { cronLine, crontabStubBin, tempHome } from "../testing/index.ts";
import {
  CRON_MARKER,
  RC_BEGIN,
  RC_END,
  systemTriggerRegistrations,
} from "./system-trigger-registrations.ts";

const OLD_CRON_MARKER =
  "# side-projects-manager: daily schedule (see scripts/install-triggers.sh)";

/**
 * `guarded-morning-run.ts` by default: what every installer that ever wrote
 * a logon guard named the script, from `d8d4439` through `b06aab9` — before
 * `3a72ac0` folded the invocation lease into `morning-run.ts` itself and
 * renamed the trigger script to match. Overridable to build a block from
 * that later naming instead.
 */
function logonGuardBlock(home: string, script = "guarded-morning-run.ts"): string {
  return [
    RC_BEGIN,
    `( "/usr/bin/node" "${home}/src/bin/${script}" >> "${home}/trigger.log" 2>&1 & )`,
    RC_END,
  ].join("\n");
}

/** Puts `bin` ahead of `PATH` for the length of the test, restoring it after. */
function withPath(t: { after: (fn: () => void) => void }, bin: string): void {
  const previous = process.env["PATH"];
  process.env["PATH"] = `${bin}:${previous ?? ""}`;
  t.after(() => {
    process.env["PATH"] = previous;
  });
}

describe("the schedule registration", () => {
  it("reports not registered when there is no crontab", async (t) => {
    withPath(t, await crontabStubBin());

    assert.deepEqual(await systemTriggerRegistrations().schedule(), {
      registered: false,
    });
  });

  it("reports not registered when nothing in the crontab carries the marker", async (t) => {
    withPath(t, await crontabStubBin(["0 3 * * * /some/other/job"]));

    assert.deepEqual(await systemTriggerRegistrations().schedule(), {
      registered: false,
    });
  });

  it("reports not registered for an old daily-marker line, so the installer replaces it", async (t) => {
    const home = await tempHome("trigger-registrations");
    withPath(t, await crontabStubBin([cronLine(home, OLD_CRON_MARKER)]));

    assert.deepEqual(await systemTriggerRegistrations().schedule(), {
      registered: false,
    });
  });

  it("reports armed with the minute and the manager home it points at", async (t) => {
    const home = await tempHome("trigger-registrations");
    withPath(t, await crontabStubBin([cronLine(home)]));

    assert.deepEqual(await systemTriggerRegistrations().schedule(), {
      registered: true,
      minute: "0",
      managerHome: home,
    });
  });

  it("reports registered but pointing at another manager home", async (t) => {
    const home = await tempHome("trigger-registrations");
    const moved = await tempHome("trigger-registrations-moved");
    withPath(t, await crontabStubBin([cronLine(moved)]));

    assert.deepEqual(await systemTriggerRegistrations().schedule(), {
      registered: true,
      minute: "0",
      managerHome: moved,
    });
    assert.notEqual(moved, home);
  });

  it("reports not registered for a marked line whose trigger-script path cannot be parsed", async (t) => {
    withPath(
      t,
      await crontabStubBin([`0 * * * * /usr/bin/node /no/quotes/here ${CRON_MARKER}`]),
    );

    assert.deepEqual(await systemTriggerRegistrations().schedule(), {
      registered: false,
    });
  });

  it("reports not registered for a marked line whose minute field is not a single whole number", async (t) => {
    const home = await tempHome("trigger-registrations");
    withPath(
      t,
      await crontabStubBin([
        `*/15 * * * * /usr/bin/node "${home}/src/bin/morning-run.ts" >> "${home}/trigger.log" 2>&1 ${CRON_MARKER}`,
      ]),
    );

    assert.deepEqual(await systemTriggerRegistrations().schedule(), {
      registered: false,
    });
  });

  it("finds the marked line among other crontab entries", async (t) => {
    const home = await tempHome("trigger-registrations");
    withPath(
      t,
      await crontabStubBin([
        "0 3 * * * /some/other/job",
        cronLine(home),
        "* * * * * /another/job",
      ]),
    );

    assert.equal((await systemTriggerRegistrations().schedule()).registered, true);
  });
});

describe("the logon guard registration", () => {
  it("reports not registered when the rc file does not exist", async () => {
    const missing = path.join(await tempHome("trigger-registrations"), "does-not-exist");

    assert.deepEqual(
      await systemTriggerRegistrations([missing]).logonGuard(),
      { registered: false },
    );
  });

  it("reports not registered when the rc file carries no logon guard block", async () => {
    const directory = await tempHome("trigger-registrations");
    const rc = path.join(directory, ".bashrc");
    await writeFile(rc, "export PATH=$PATH:/usr/local/bin\n");

    assert.deepEqual(
      await systemTriggerRegistrations([rc]).logonGuard(),
      { registered: false },
    );
  });

  it("reports armed when the rc file carries the block, pointing at this manager home", async () => {
    const directory = await tempHome("trigger-registrations");
    const rc = path.join(directory, ".bashrc");
    await writeFile(rc, `${logonGuardBlock(directory)}\n`);

    assert.deepEqual(await systemTriggerRegistrations([rc]).logonGuard(), {
      registered: true,
      managerHome: directory,
    });
  });

  it("reports registered but pointing at another manager home", async () => {
    const directory = await tempHome("trigger-registrations");
    const moved = await tempHome("trigger-registrations-moved");
    const rc = path.join(directory, ".bashrc");
    await writeFile(rc, `${logonGuardBlock(moved)}\n`);

    assert.deepEqual(await systemTriggerRegistrations([rc]).logonGuard(), {
      registered: true,
      managerHome: moved,
    });
  });

  it("reports armed for a block naming the current morning-run.ts script", async () => {
    const directory = await tempHome("trigger-registrations");
    const rc = path.join(directory, ".bashrc");
    await writeFile(rc, `${logonGuardBlock(directory, "morning-run.ts")}\n`);

    assert.deepEqual(await systemTriggerRegistrations([rc]).logonGuard(), {
      registered: true,
      managerHome: directory,
    });
  });

  it("reports not registered for a block whose trigger-script path cannot be parsed", async () => {
    const directory = await tempHome("trigger-registrations");
    const rc = path.join(directory, ".bashrc");
    await writeFile(rc, `${[RC_BEGIN, "( /usr/bin/node /no/quotes/here & )", RC_END].join("\n")}\n`);

    assert.deepEqual(await systemTriggerRegistrations([rc]).logonGuard(), {
      registered: false,
    });
  });

  it("reads the first block when the rc file carries it twice", async () => {
    const directory = await tempHome("trigger-registrations");
    const moved = await tempHome("trigger-registrations-moved");
    const rc = path.join(directory, ".bashrc");
    await writeFile(
      rc,
      `${logonGuardBlock(directory)}\n\n${logonGuardBlock(moved)}\n`,
    );

    assert.deepEqual(await systemTriggerRegistrations([rc]).logonGuard(), {
      registered: true,
      managerHome: directory,
    });
  });

  it("falls through to the next rc file when the first carries no block", async () => {
    const directory = await tempHome("trigger-registrations");
    const bashrc = path.join(directory, ".bashrc");
    const zshrc = path.join(directory, ".zshrc");
    await writeFile(bashrc, "export PATH=$PATH:/usr/local/bin\n");
    await writeFile(zshrc, `${logonGuardBlock(directory)}\n`);

    assert.deepEqual(
      await systemTriggerRegistrations([bashrc, zshrc]).logonGuard(),
      { registered: true, managerHome: directory },
    );
  });
});
