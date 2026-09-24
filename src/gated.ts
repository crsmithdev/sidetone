/**
 * 10.7 the agent's own actions that need the agreement word: a force push, a
 * remote branch delete, `rm -rf` outside the project, and a drop or truncate
 * of a database. Everything else the agent does needs no word (6.3).
 *
 * Two halves. `ASK_RULES` makes Claude Code send the bridge a permission
 * request for a wide set of commands; auto mode decides the rest without the
 * bridge. `gatedAction` then picks the four out of that set and says each one
 * as a sentence the voice can read back (10.4). A request it does not pick is
 * let through.
 *
 * Measured 24 September on claude 2.1.282, in auto mode: with no ask rules,
 * three force pushes of three ran and no request came. With these rules,
 * every force push, both forms of a remote delete, both forms of `rm -rf`, a
 * DROP inside a quoted script and a compound command each sent a request, and
 * `ls` did not.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";

/** What Claude Code asks the bridge about. A wide net: `gatedAction` decides. */
export const ASK_RULES = [
  "Bash(git push *)",
  "Bash(rm *)",
  "Bash(*DROP *)",
  "Bash(*drop *)",
  "Bash(*TRUNCATE *)",
  "Bash(*truncate *)",
  "Bash(dropdb *)",
];

/**
 * The sentence the bridge reads back before a gated action, or null for an
 * action that is not gated. `project` is the directory the agent runs in.
 */
export function gatedAction(tool: string, input: Record<string, unknown>, project: string): string | null {
  if (tool !== "Bash" || typeof input.command !== "string") return null;
  const command = input.command;
  let cwd = project;
  for (const words of segments(command)) {
    const [name, ...args] = withoutPrefixes(words);
    if (name === "cd" && args[0]) { cwd = pathOf(args[0], cwd); continue; }
    const found = (name === "git" && push(args)) || (name === "rm" && removal(args, cwd, project)) || (name === "dropdb" && dropdb(args));
    if (found) return found;
  }
  return drop(command);
}

/** A git command's arguments: a force push or a remote delete, as a readback. */
function push(args: string[]): string | null {
  // git's own options come before the subcommand; -C and -c take a value
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) i += args[i] === "-C" || args[i] === "-c" ? 2 : 1;
  if (args[i] !== "push") return null;
  let force = false;
  let remove = false;
  let prune = false;
  const positional: string[] = [];
  for (const arg of args.slice(i + 1)) {
    if (arg === "--force" || arg.startsWith("--force-with-lease")) force = true;
    else if (arg === "--delete") remove = true;
    else if (arg === "--prune" || arg === "--mirror") prune = true;
    else if (/^-[A-Za-z]+$/.test(arg)) { force ||= arg.includes("f"); remove ||= arg.includes("d"); }
    else if (!arg.startsWith("-")) positional.push(arg);
  }
  const [remote, ...refspecs] = positional;
  if (refspecs.some((ref) => ref.startsWith("+"))) force = true;
  const deleted = remove ? refspecs : refspecs.filter((ref) => ref.startsWith(":"));
  if (deleted.length > 0) {
    const names = deleted.map((ref) => branch(ref.replace(/^:/, "")));
    const which = names.length === 1 ? `the branch ${names[0]}` : `the branches ${and(names)}`;
    return `The agent wants to delete ${which}${remote ? ` on ${remote}` : ""}.`;
  }
  if (prune) return `The agent wants to delete remote branches${remote ? ` on ${remote}` : ""}.`;
  if (!force) return null;
  const to = [remote, ...refspecs.map((ref) => branch(ref.replace(/^\+/, "").split(":").at(-1)!))].filter(Boolean).join(" ");
  return `The agent wants to force push${to ? ` to ${to}` : ""}.`;
}

/** `rm` with both -r and -f, on a path that is not under the project. */
function removal(args: string[], cwd: string, project: string): string | null {
  let recursive = false;
  let force = false;
  const paths: string[] = [];
  let options = true;
  for (const arg of args) {
    if (options && arg === "--") { options = false; continue; }
    if (options && arg === "--recursive") recursive = true;
    else if (options && arg === "--force") force = true;
    else if (options && /^-[A-Za-z]+$/.test(arg)) { recursive ||= /[rR]/.test(arg); force ||= arg.includes("f"); }
    else if (!options || !arg.startsWith("-")) paths.push(arg);
  }
  if (!recursive || !force) return null;
  const outside = paths.map((path) => pathOf(path, cwd)).filter((path) => !path.startsWith(`${project}/`));
  if (outside.length === 0) return null;
  return `The agent wants to delete ${and(outside)} and everything in ${outside.length === 1 ? "it" : "them"}.`;
}

function dropdb(args: string[]): string | null {
  const name = args.filter((arg) => !arg.startsWith("-")).at(-1);
  return `The agent wants to drop the database${name ? ` ${name}` : ""}.`;
}

/** SQL sits inside a quoted argument, so the drop is looked for in the whole command. */
function drop(command: string): string | null {
  const match = /\b(drop\s+(?:database|schema|table)(?:\s+if\s+exists)?|truncate(?:\s+table)?)\s+[`"']?([\w.]+)/i.exec(command);
  if (!match) return null;
  return `The agent wants to run ${match[1]!.toUpperCase().replace(/\s+/g, " ")} ${match[2]}.`;
}

/**
 * A path as the shell would reach it from `cwd`. A path that holds a variable
 * or a command the shell would expand cannot be known here, so it stays as
 * written, which is never under the project: the gate fails closed (10.5).
 */
function pathOf(path: string, cwd: string): string {
  const home = path.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, homedir());
  if (/[$`]/.test(home)) return home;
  return resolve(cwd, home);
}

function branch(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

function and(items: string[]): string {
  return items.length === 1 ? items[0]! : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The words a segment starts with that only run the command after them. */
function withoutPrefixes(words: string[]): string[] {
  let i = 0;
  while (i < words.length && (/^\w+=/.test(words[i]!) || ["sudo", "env", "command", "exec", "nohup", "time"].includes(words[i]!))) i++;
  return words.slice(i);
}

/**
 * A command line as the shell splits it: into the commands between `;`,
 * `&&`, `||`, `|`, `&` and a newline, and each into words, with the quotes
 * taken off. It does not look inside `$(...)`, a backtick or `bash -c`.
 */
function segments(command: string): string[][] {
  const result: string[][] = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  let quote: string | null = null;
  const endWord = () => { if (started) words.push(word); word = ""; started = false; };
  const endSegment = () => { endWord(); if (words.length) result.push(words); words = []; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
    if (ch === "\\" && i + 1 < command.length) { word += command[++i]; started = true; continue; }
    if (ch === " " || ch === "\t") { endWord(); continue; }
    if (";&|\n".includes(ch)) { endSegment(); continue; }
    word += ch;
    started = true;
  }
  endSegment();
  return result;
}
