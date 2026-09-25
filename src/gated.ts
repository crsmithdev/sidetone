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
 * `ls` did not. `bash -c`, `sh -c`, `eval`, `find -delete`, `find -exec rm -rf`
 * and `Drop table` sent none until they had rules of their own.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * What Claude Code asks the bridge about. A wide net: `gatedAction` decides.
 * The rules match case, and they do not look inside a shell string, so a
 * shell, `eval`, `find` and the title case of DROP and TRUNCATE have their own.
 */
export const ASK_RULES = [
  "Bash(git push *)",
  "Bash(rm *)",
  "Bash(*DROP *)",
  "Bash(*Drop *)",
  "Bash(*drop *)",
  "Bash(*TRUNCATE *)",
  "Bash(*Truncate *)",
  "Bash(*truncate *)",
  "Bash(dropdb *)",
  "Bash(bash *)",
  "Bash(sh *)",
  "Bash(eval *)",
  "Bash(xargs *)",
  "Bash(find *)",
];

/**
 * The sentence the bridge reads back before a gated action, or null for an
 * action that is not gated. `project` is the directory the agent runs in.
 */
export function gatedAction(tool: string, input: Record<string, unknown>, project: string): string | null {
  if (tool !== "Bash" || typeof input.command !== "string") return null;
  return scan(input.command, project, project) ?? drop(input.command);
}

/** 10.7.6 what the bridge reads back for a command it cannot split into words. */
const UNREADABLE = "The agent wants to run a command that the bridge cannot read.";

/** A command line, and each command and shell string inside it, checked for the first three actions. */
function scan(command: string, cwd: string, project: string): string | null {
  const parsed = segments(command);
  if (!parsed) return UNREADABLE;
  for (const { words, inner } of parsed) {
    for (const nested of inner) {
      const found = scan(nested, cwd, project);
      if (found) return found;
    }
    const [name, ...args] = withoutPrefixes(words);
    if (name === "cd" && args[0]) { cwd = pathOf(args[0], cwd); continue; }
    const found = check(name, args, cwd, project);
    if (found) return found;
  }
  return null;
}

/** One command's name and arguments, as a readback or null. */
function check(name: string | undefined, args: string[], cwd: string, project: string): string | null {
  if (name === undefined) return null;
  // a name the shell expands is a command nobody can know here
  if (/^[$`]/.test(name)) return UNREADABLE;
  if (name === "git") return push(args);
  if (name === "rm") return removal(args, cwd, project);
  if (name === "dropdb") return dropdb(args);
  if (name === "bash" || name === "sh") return shell(args, cwd, project);
  if (name === "eval") return scan(args.join(" "), cwd, project);
  if (name === "xargs") return xargs(args, cwd, project);
  if (name === "find") return find(args, cwd, project);
  return null;
}

/** `bash -c <string>` or `sh -c <string>`: the string is a command line. A script file is not read. */
function shell(args: string[], cwd: string, project: string): string | null {
  let i = 0;
  let string = false;
  while (i < args.length && /^[-+]/.test(args[i]!)) {
    if (args[i] === "-o" || args[i] === "+o") i++;
    else if (/^-[A-Za-z]*c/.test(args[i]!)) string = true;
    i++;
  }
  if (!string) return null;
  if (i >= args.length) return UNREADABLE;
  return scan(args[i]!, cwd, project);
}

/** The xargs options that take the next word as their value. */
const XARGS_VALUES = ["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter", "--eof", "--replace", "--max-lines", "--max-args", "--max-procs", "--max-chars"];

/** xargs runs the command after its options, with the paths it reads added: those cannot be known here. */
function xargs(args: string[], cwd: string, project: string): string | null {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) i += XARGS_VALUES.includes(args[i]!) ? 2 : 1;
  const [name, ...rest] = args.slice(i);
  if (name === "rm" && flags(rest).recursive && flags(rest).force) return "The agent wants to run rm -rf on each path that xargs reads.";
  return check(name, rest, cwd, project);
}

/** `find` with `-delete`, or with `-exec rm -rf`, on a start path that is not in the project. */
function find(args: string[], cwd: string, project: string): string | null {
  let i = 0;
  while (i < args.length && /^-[HLP]$/.test(args[i]!)) i++;
  const starts: string[] = [];
  while (i < args.length && !/^[-(!]/.test(args[i]!)) starts.push(args[i++]!);
  let deletes = false;
  while (i < args.length) {
    const arg = args[i++]!;
    if (arg === "-delete") { deletes = true; continue; }
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(arg)) continue;
    const end = args.findIndex((word, j) => j >= i && (word === ";" || word === "+"));
    const [name, ...rest] = args.slice(i, end < 0 ? undefined : end);
    i = end < 0 ? args.length : end + 1;
    if (name === "rm") { const { recursive, force } = flags(rest); deletes ||= recursive && force; continue; }
    const found = check(name, rest, cwd, project);
    if (found) return found;
  }
  if (!deletes) return null;
  const outside = (starts.length ? starts : ["."]).map((path) => pathOf(path, cwd)).filter((path) => !within(path, project, true));
  if (outside.length === 0) return null;
  return `The agent wants to delete what find matches in ${and(outside)}.`;
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
  const { recursive, force, paths } = flags(args);
  if (!recursive || !force) return null;
  const outside = paths.map((path) => pathOf(path, cwd)).filter((path) => !within(path, project, false));
  if (outside.length === 0) return null;
  return `The agent wants to delete ${and(outside)} and everything in ${outside.length === 1 ? "it" : "them"}.`;
}

/** The options and paths of an `rm`. */
function flags(args: string[]): { recursive: boolean; force: boolean; paths: string[] } {
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
  return { recursive, force, paths };
}

/** A path below the project; the project itself counts only when `self` is set. */
function within(path: string, project: string, self: boolean): boolean {
  return path.startsWith(`${project}/`) || (self && path === project);
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
 * taken off. A `$(...)` or a backtick stays in its word as written, and its
 * text is also given as a command line of its own. Null when a quote, a
 * `$(` or a backtick does not close.
 */
function segments(command: string): { words: string[]; inner: string[] }[] | null {
  const result: { words: string[]; inner: string[] }[] = [];
  let words: string[] = [];
  let inner: string[] = [];
  let word = "";
  let started = false;
  let quote: string | null = null;
  const endWord = () => { if (started) words.push(word); word = ""; started = false; };
  const endSegment = () => { endWord(); if (words.length || inner.length) result.push({ words, inner }); words = []; inner = []; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote !== "'" && (ch === "`" || (ch === "$" && command[i + 1] === "("))) {
      const end = ch === "`" ? command.indexOf("`", i + 1) : closing(command, i + 2);
      if (end < 0) return null;
      inner.push(command.slice(i + (ch === "`" ? 1 : 2), end));
      word += command.slice(i, end + 1);
      started = true;
      i = end;
      continue;
    }
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
  if (quote) return null;
  endSegment();
  return result;
}

/** The index of the `)` that closes a `$(` whose text starts at `from`, or -1. */
function closing(command: string, from: number): number {
  let depth = 1;
  let quote: string | null = null;
  for (let i = from; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"') i++;
      continue;
    }
    if (ch === "\\") i++;
    else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return -1;
}
