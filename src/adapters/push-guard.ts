// Dependency-free beyond a type import (stripped before the hook ships), and `pushRefusal` is one
// self-contained function, because `pushGuardHookCommand` ships that function's own source into the
// container as the hook's program: nothing else of `src/` is there to import, and the image's node
// reads plain JavaScript through `-e`.

import type { Branch } from "../ports/branch.ts";

/** What a run may push: the branch nobody pushes to, and whether `--force-with-lease` is allowed. */
export interface PushPolicy {
  base: Branch;
  lease: boolean;
}

/**
 * Why a Bash `command` is refused, or `undefined` when it pushes nothing the
 * policy forbids. Every `git push` in the command is read, however it is
 * spelled — behind `;`, `&&`, `|`, a subshell, `env`, `sudo`, `bash -c '…'`,
 * `git -C dir`, `git -c k=v` — and refused when it:
 *
 * - targets `policy.base`: a refspec naming it (`base`, `HEAD:base`,
 *   `refs/heads/base`, `heads/base`, `:base`, `+base`), a wildcard refspec,
 *   the matching refspec `:`, `--all`, `--mirror`, or no refspec at all while
 *   the current branch is `base`;
 * - force-pushes: `--force`, `-f` in a short cluster, a `+` refspec,
 *   `--mirror`, and `--force-with-lease` unless `policy.lease`;
 * - cannot be read: an argument with a `$` or `{` in it (`$'base'`,
 *   `{base,x}`, `$ARGS`), a `-c` setting `remote.*.push`, `push.*` or
 *   `alias.*`, or an implicit or `HEAD` push after a `cd`, `checkout` or
 *   `switch`, since the branch it would send is not the one the hook saw.
 *
 * `currentBranch` answers for the branch a push without a refspec (or with
 * `HEAD`) would send, given the `-C` directories in front of the push, in
 * order; `undefined` is a detached HEAD or no repository. A `git push` named
 * anywhere in a command is read as run, even as an argument to `echo`. A bare
 * push is read as going to the current branch's name; where repository config
 * (`remote.*.push` set earlier, `push.default`) would send it is not read.
 */
export function pushRefusal(
  command: string,
  policy: PushPolicy,
  currentBranch: (directories: string[]) => string | undefined,
): string | undefined {
  /** Splits `text` into commands, each a list of words, with quotes resolved. */
  function commands(text: string): string[][] {
    const found: string[][] = [];
    let words: string[] = [];
    let word = "";
    let started = false;
    const endWord = () => {
      if (started) words.push(word);
      word = "";
      started = false;
    };
    const endCommand = () => {
      endWord();
      if (words.length > 0) found.push(words);
      words = [];
    };
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index] ?? "";
      if (character === "'") {
        const close = text.indexOf("'", index + 1);
        const end = close === -1 ? text.length : close;
        word += text.slice(index + 1, end);
        started = true;
        index = end;
      } else if (character === '"') {
        started = true;
        index += 1;
        while (index < text.length && text[index] !== '"') {
          if (text[index] === "\\" && index + 1 < text.length) index += 1;
          word += text[index] ?? "";
          index += 1;
        }
      } else if (character === "\\" && index + 1 < text.length) {
        if (text[index + 1] !== "\n") {
          word += text[index + 1] ?? "";
          started = true;
        }
        index += 1;
      } else if (/\s/.test(character) && character !== "\n") {
        endWord();
      } else if (";&|()`\n".includes(character)) {
        endCommand();
      } else if (character === "$" && text[index + 1] === "(") {
        endCommand();
      } else {
        word += character;
        started = true;
      }
    }
    endCommand();
    return found;
  }

  const toBase = `a push to ${policy.base}`;
  const unreadable = "a push whose destination it cannot read";
  const optionsWithValue = ["--repo", "--push-option", "--receive-pack", "--exec"];
  const gitOptionsWithValue = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"];
  /** Config that moves where a push goes, or hides one behind an alias. */
  const redirectingConfig = /^(remote\.[^=]*\.push|push\.|alias\.)/i;
  /** Set once a command switches branch or directory: the clone is no longer where the hook saw it. */
  let moved = false;

  /** The refusal for the arguments after `git [options] push`, if any. */
  function refusalOf(args: string[], directories: string[]): string | undefined {
    const positionals: string[] = [];
    let force = false;
    let lease = false;
    let everything = false;
    let optionsEnded = false;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === undefined) continue;
      if (optionsEnded || !arg.startsWith("-") || arg === "-") {
        positionals.push(arg);
      } else if (arg === "--") {
        optionsEnded = true;
      } else if (optionsWithValue.includes(arg)) {
        index += 1;
      } else if (arg === "--force") {
        force = true;
      } else if (arg.startsWith("--force-with-lease")) {
        lease = true;
      } else if (arg === "--mirror") {
        force = true;
        everything = true;
      } else if (arg === "--all" || arg === "--branches") {
        everything = true;
      } else if (!arg.startsWith("--")) {
        // A short cluster: `-o` ends it, taking the rest of the cluster or the next word as its value.
        for (let at = 1; at < arg.length; at += 1) {
          if (arg[at] === "o") {
            if (at === arg.length - 1) index += 1;
            break;
          }
          if (arg[at] === "f") force = true;
        }
      }
    }
    const [, ...refspecs] = positionals;
    if (refspecs.some((refspec) => refspec.startsWith("+"))) force = true;
    if (force || (lease && !policy.lease)) return "a force-push";
    if (args.some((arg) => arg.includes("$") || arg.includes("{"))) return unreadable;

    const withoutHeadsPrefix = (name: string) => name.replace(/^refs\/heads\//, "");
    const current = () => currentBranch(directories);
    if (everything) return toBase;
    if (refspecs.length === 0) {
      if (moved) return unreadable;
      return current() === policy.base ? toBase : undefined;
    }
    for (const refspec of refspecs) {
      const bare = refspec.replace(/^\+/, "");
      if (bare === ":") return toBase;
      const colon = bare.lastIndexOf(":");
      let target = withoutHeadsPrefix(colon === -1 ? bare : bare.slice(colon + 1));
      if (target === "HEAD" || target === "@") {
        if (moved) return unreadable;
        target = current() ?? "";
      }
      if (target === policy.base || target.endsWith(`/${policy.base}`) || target.includes("*")) {
        return toBase;
      }
    }
    return undefined;
  }

  /** The refusal for one command's words, looking inside any word that is itself a command line. */
  function refusalIn(words: string[]): string | undefined {
    for (const word of words) {
      if (/\s/.test(word)) {
        for (const inner of commands(word)) {
          const refusal = refusalIn(inner);
          if (refusal !== undefined) return refusal;
        }
      }
    }
    if (words[0] === "cd" || words[0] === "pushd") moved = true;
    for (let at = 0; at < words.length; at += 1) {
      if (words[at]?.split("/").pop() !== "git") continue;
      const directories: string[] = [];
      let index = at + 1;
      for (let option = words[index]; option?.startsWith("-"); option = words[index]) {
        const value = words[index + 1];
        if (option === "-C" && value !== undefined) directories.push(value);
        if (option === "-c" && redirectingConfig.test(words[index + 1] ?? "")) return unreadable;
        index += gitOptionsWithValue.includes(option) ? 2 : 1;
      }
      if (words[index] === "checkout" || words[index] === "switch") moved = true;
      if (words[index] === "push") {
        const refusal = refusalOf(words.slice(index + 1), directories);
        if (refusal !== undefined) return refusal;
      }
    }
    return undefined;
  }

  for (const words of commands(command)) {
    const refusal = refusalIn(words);
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}

/**
 * The program a `PreToolUse` hook runs: reads the tool call from stdin and,
 * for a Bash call `pushRefusal` refuses under `policy`, says why on stderr and
 * exits 2, which the agent CLI takes as a refusal whatever the permission
 * mode. Input it cannot parse, and a crash of its own, are let through rather
 * than breaking every run (ADR 0001).
 */
function pushGuardProgram(policy: PushPolicy): string {
  return `
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const pushRefusal = ${pushRefusal.toString()};
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  let call;
  try { call = JSON.parse(input); } catch { return; }
  if (call.tool_name !== "Bash" || typeof call.tool_input?.command !== "string") return;
  const currentBranch = (directories) => {
    try {
      const where = path.resolve(call.cwd ?? process.cwd(), ...directories);
      const out = execFileSync("git", ["-C", where, "symbolic-ref", "--short", "-q", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return out.trim() || undefined;
    } catch { return undefined; }
  };
  const refusal = pushRefusal(call.tool_input.command, ${JSON.stringify(policy)}, currentBranch);
  if (refusal !== undefined) {
    process.stderr.write("The manager refuses " + refusal + " in this run.");
    process.exit(2);
  }
});
`;
}

/**
 * The shell command a hook runs to guard pushes under `policy`. The program
 * travels base64-encoded, so no quoting of its source can go wrong.
 */
export function pushGuardHookCommand(policy: PushPolicy): string {
  const encoded = Buffer.from(pushGuardProgram(policy)).toString("base64");
  return `node -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}
