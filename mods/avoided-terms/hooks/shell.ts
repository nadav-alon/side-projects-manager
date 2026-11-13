// The simple commands of a shell command, as a mod works them out: a copy of `simpleCommands` in
// `size-reminder/hooks/reminder.ts`, since a mod can only import from its own folder.

/**
 * The command's simple commands, each as its words; quotes group, `&&` `||` `;` `|` `&` `(` `)` and newlines
 * split, a backslash before a newline joins the lines, and a `#` opening a word comments out the line.
 */
export function simpleCommands(command: string): string[][] {
  const commands: string[][] = [[]]
  let word: string | null = null
  let quote: '"' | "'" | null = null
  const endWord = () => {
    if (word !== null) commands[commands.length - 1]!.push(word)
    word = null
  }
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!
    if (quote !== null) {
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"' && command[i + 1] === '\n') i++
      else if (char === '\\' && quote === '"' && i + 1 < command.length) word += command[++i]!
      else word += char
    } else if (char === '"' || char === "'") {
      quote = char
      word ??= ''
    } else if (char === '\\' && command[i + 1] === '\n') {
      i++
    } else if (char === '\\' && i + 1 < command.length) {
      word = (word ?? '') + command[++i]!
    } else if (char === '#' && word === null) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i++
    } else if (/\s/.test(char) && char !== '\n') {
      endWord()
    } else if (char === '\n' || char === ';' || char === '|' || char === '&' || char === '(' || char === ')') {
      endWord()
      if (commands[commands.length - 1]!.length > 0) commands.push([])
    } else {
      word = (word ?? '') + char
    }
  }
  endWord()
  return commands.filter((words) => words.length > 0)
}
