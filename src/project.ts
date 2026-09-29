/**
 * Item 77 the project the agent works in, and the other projects Chris can
 * switch to by voice ("sidetone, switch to cloudchamber").
 *
 * The names come from the aleph repo registry, which Chris edits by hand or
 * asks the agent to edit. The bridge reads it at each switch, so a project
 * added to it needs no restart. The active project is kept in a state file,
 * so a restart of the bridge starts the agent in the same project. Each
 * project has its own handoff (item 72), named for the project.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { editDistance, normalize, tolerance } from "./commands.ts";

export interface Project {
  /** the key of the registry, which is also the name of its handoff */
  name: string;
  /** the directory the agent runs in, so the project's CLAUDE.md loads */
  dir: string;
}

/** Where the registry, the state and the handoffs are. A test gives its own. */
export interface ProjectFiles {
  registry: string;
  state: string;
  handoffs: string;
}

/**
 * `$ALEPH_REPOS` moves the registry, as it does for aleph, and
 * `$SIDETONE_PROJECT` the state. The switch check gives a bridge both, so it
 * never reads the real registry or writes the real state.
 */
export const PROJECT_FILES: ProjectFiles = {
  registry: process.env.ALEPH_REPOS ?? join(homedir(), ".aleph", "repos.json"),
  state: process.env.SIDETONE_PROJECT ?? join(homedir(), ".sidetone", "project.json"),
  handoffs: join(homedir(), ".aleph", "handoffs"),
};

/** Item 72 the skills that write and read a project's handoff. */
export const handoffOf = (name: string): string => `/aleph:handoff ${name}`;
export const pickupOf = (name: string): string => `/aleph:pickup ${name}`;

export class Projects {
  /** the project the agent works in now */
  current: Project;

  /**
   * `dir` is the directory the bridge was started with. It is the project
   * when the state file names none, or names one the registry no longer holds.
   */
  constructor(private readonly files: ProjectFiles, dir: string) {
    const all = this.all();
    const saved = readState(files.state);
    const at = resolve(dir);
    this.current = all.find((project) => project.name === saved)
      ?? all.find((project) => project.dir === at)
      ?? { name: basename(at), dir: at };
  }

  /** Every project in the registry, read now. A registry that cannot be read holds none. */
  all(): Project[] {
    let entries: Record<string, { path?: unknown }>;
    try { entries = JSON.parse(readFileSync(this.files.registry, "utf8")) as Record<string, { path?: unknown }>; } catch { return []; }
    return Object.entries(entries)
      .filter(([, entry]) => typeof entry?.path === "string")
      .map(([name, entry]) => ({ name, dir: resolve((entry.path as string).replace(/^~(?=\/|$)/, homedir())) }));
  }

  /** The project is now `project`, and stays so across a restart. */
  select(project: Project): void {
    this.current = project;
    mkdirSync(dirname(this.files.state), { recursive: true });
    writeFileSync(this.files.state, `${JSON.stringify({ project: project.name })}\n`);
  }

  /** The handoff file of a project, which its pickup reads. */
  handoffFile(name: string): string {
    return join(this.files.handoffs, `${name}.md`);
  }

  /** Whether a project has a handoff to pick up. */
  hasHandoff(name: string): boolean {
    return existsSync(this.handoffFile(name));
  }
}

function readState(file: string): string | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as { project?: unknown };
    return typeof value.project === "string" ? value.project : null;
  } catch {
    return null;
  }
}

/**
 * The project whose name sounds like `heard`, or null. The engine writes
 * "cloudchamber" as "cloud chamber", so the spaces close up, and a name
 * forgives a spelling difference as a command word does (9.3). The closest
 * name wins.
 */
export function projectNamed(heard: string, projects: Project[]): Project | null {
  const said = normalize(heard).replace(/ /g, "");
  if (!said) return null;
  let best: { project: Project; distance: number } | null = null;
  for (const project of projects) {
    const name = normalize(project.name).replace(/ /g, "");
    const distance = editDistance(said, name);
    if (distance <= tolerance(name) && (!best || distance < best.distance)) best = { project, distance };
  }
  return best?.project ?? null;
}
