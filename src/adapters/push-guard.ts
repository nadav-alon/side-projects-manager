// Dependency-free, and `pushRefusal` is one self-contained function, because `pushGuardHookCommand`
// ships that function's own source into the container as the hook's program: nothing else of
// `src/` is there to import, and the image's node reads plain JavaScript through `-e`.

/** What a run may push: the branch nobody pushes to, and whether `--force-with-lease` is allowed. */
export interface PushPolicy {
  base: string;
  lease: boolean;
}

/**
 * Why a Bash `command` is refused, or `undefined` when it pushes nothing the
 * policy forbids. Every `git push` in the command is read, however it is
 * spelled — behind `;`, `&&`, `|`, a subshell, `env`, `sudo`, `bash -c '…'`,
 * `git -C dir`, `git -c k=v` — and refused when it:
 *
 * - targets `policy.base`: a refspec naming it (`base`, `HEAD:base`,
 *   `refs/heads/base`, `:base`, `+base`), a wildcard refspec, `--all`,
 *   `--mirror`, or no refspec at all while the current branch is `base`;
 * - force-pushes: `--force`, `-f` in a short cluster, a `+` refspec,
 *   `--mirror`, and `--force-with-lease` unless `policy.lease`.
 *
 * `currentBranch` answers for the branch a push without a refspec (or with
 * `HEAD`) would send, given the `-C` directories in front of the push, in
 * order; `undefined` is a detached HEAD or no repository. A `git push` named
 * anywhere in a command is read as run, even as an argument to `echo`. A command that
 * builds its push out of expansions (`git push $ARGS`) cannot be read and is
 * not refused.
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
      const character = text[index];
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
          word += text[index];
          index += 1;
        }
      } else if (character === "\\" && index + 1 < text.length) {
        if (text[index + 1] !== "\n") {
          word += text[index + 1];
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

  /** The refusal for the arguments after `git [options] push`, if any. */
  function refusalOf(args: string[], directories: string[]): string | undefined {
    const withValue = ["--repo", "-o", "--push-option", "--receive-pack", "--exec"];
    const positionals: string[] = [];
    let force = false;
    let lease = false;
    let everything = false;
    let optionsEnded = false;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (optionsEnded || !arg.startsWith("-") || arg === "-") {
        positionals.push(arg);
      } else if (arg === "--") {
        optionsEnded = true;
      } else if (withValue.includes(arg)) {
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
      } else if (!arg.startsWith("--") && arg.includes("f")) {
        force = true;
      }
    }
    const [, ...refspecs] = positionals;
    if (refspecs.some((refspec) => refspec.startsWith("+"))) force = true;
    if (force) return "a force-push";
    if (lease && !policy.lease) return "a force-push";

    const branch = (name: string) => name.replace(/^refs\/heads\//, "");
    const current = () => currentBranch(directories);
    if (everything) return `a push to ${policy.base}`;
    if (refspecs.length === 0) {
      return current() === policy.base ? `a push to ${policy.base}` : undefined;
    }
    for (const refspec of refspecs) {
      const bare = refspec.replace(/^\+/, "");
      const colon = bare.lastIndexOf(":");
      let target = branch(colon === -1 ? bare : bare.slice(colon + 1));
      if (target === "HEAD" || target === "@") target = current() ?? "";
      if (target === policy.base || target.includes("*")) return `a push to ${policy.base}`;
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
    for (let at = 0; at < words.length; at += 1) {
      if (words[at].split("/").pop() !== "git") continue;
      const directories: string[] = [];
      let index = at + 1;
      while (index < words.length && words[index].startsWith("-")) {
        const option = words[index];
        if (option === "-C" && index + 1 < words.length) directories.push(words[index + 1]);
        const takesValue = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"];
        index += takesValue.includes(option) ? 2 : 1;
      }
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
 * mode. Anything it cannot read is let through rather than breaking every run.
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
