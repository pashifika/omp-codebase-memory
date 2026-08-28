import path from "node:path";

import type { GraphClient } from "./graph.ts";

/**
 * Which indexed project a session's working directory belongs to.
 *
 * Every graph query CBM exposes needs a project name, and a session only knows
 * a working directory. `list_projects` returns each project's `name` and
 * `root_path`, so the mapping is one call and needs no walk-up guessing at an
 * identity CBM already records -- a walk-up can also land on a root CBM never
 * indexed, which is a name every query would then reject.
 *
 * Resolved once per session and reused. The working directory does not change
 * mid-session in a way that would move the project, and paying a graph query per
 * `grep` to re-derive a constant is exactly the cost the augmentation's deadline
 * exists to bound.
 */

/** One indexed project, as `list_projects` records it. */
export interface IndexedProject {
  readonly name: string;
  /** The absolute path CBM recorded as the project root. */
  readonly root: string;
}

/**
 * What the resolution established.
 *
 * `unindexed` and `unavailable` are separate because they earn different
 * treatment: an unindexed working directory is a persistent, explainable state
 * worth one notice per session, while a graph that did not answer is a debug
 * line and nothing else.
 */
export type ProjectResolution =
  | { readonly kind: "project"; readonly project: IndexedProject }
  | { readonly kind: "unindexed" }
  | { readonly kind: "unavailable" };

/**
 * The project whose recorded root contains `cwd`, or `null`.
 *
 * The longest matching root wins, so a nested project beats the parent it sits
 * inside. A root that is a *sibling* prefix of `cwd` -- `/work/app` against
 * `/work/app-v2` -- is not a match, which is why the comparison appends a
 * separator rather than testing the prefix directly.
 */
export function selectProject(projects: readonly IndexedProject[], cwd: string): IndexedProject | null {
  const directory = path.resolve(cwd);
  let best: IndexedProject | null = null;
  for (const candidate of projects) {
    const root = path.resolve(candidate.root);
    if (root !== directory && !directory.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)) continue;
    if (best === null || path.resolve(best.root).length < root.length) best = candidate;
  }
  return best;
}

/**
 * The projects named in a `list_projects` response.
 *
 * Reads only the two fields it uses, and drops an entry missing either: a
 * project with no name cannot be queried and one with no root cannot be
 * matched, so neither can contribute to a resolution.
 */
export function readProjects(structured: unknown): readonly IndexedProject[] | null {
  if (typeof structured !== "object" || structured === null || !("projects" in structured)) return null;
  const listed = structured.projects;
  if (!Array.isArray(listed)) return null;

  const projects: IndexedProject[] = [];
  for (const entry of listed as readonly unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    if (!("name" in entry) || !("root_path" in entry)) continue;
    const { name, root_path: root } = entry;
    if (typeof name !== "string" || typeof root !== "string" || name === "" || root === "") continue;
    projects.push({ name, root });
  }
  return projects;
}

export interface ProjectResolver {
  /** The session's project. The graph is asked once; every later call reuses it. */
  resolve(): Promise<ProjectResolution>;
}

/**
 * A resolver over one graph client and one working directory.
 *
 * Only a *definitive* answer is cached. A graph that did not answer is not one:
 * the commonest cause is a search arriving while the session's handshake is
 * still in flight, and caching that would disable augmentation for the whole
 * session over a few seconds of startup. Measured: the handshake takes ~2.9 s
 * against a warm CBM daemon and ~8.6 s when the daemon has to start, and this
 * was exactly the bug -- one early `grep` poisoned every later one.
 *
 * Retrying costs one bounded `list_projects` per tool result until it succeeds,
 * which is the same bound every other query already has.
 */
export function projectResolver(client: GraphClient, cwd: string): ProjectResolver {
  let settled: ProjectResolution | null = null;
  let inFlight: Promise<ProjectResolution> | null = null;

  return {
    async resolve() {
      if (settled !== null) return settled;
      // Concurrent callers share one query rather than racing several.
      inFlight ??= (async (): Promise<ProjectResolution> => {
        try {
          // No cache-root override, here or anywhere: CBM refuses a command
          // configured against a root other than the active daemon's, and that
          // root is the only one holding the index this session can see.
          const projects = readProjects(await client.call("list_projects", {}));
          if (projects === null) return { kind: "unavailable" };
          // An empty list and no match are the same state -- no indexed project
          // -- and neither is an error.
          const project = selectProject(projects, cwd);
          return project === null ? { kind: "unindexed" } : { kind: "project", project };
        } finally {
          inFlight = null;
        }
      })();

      const answer = await inFlight;
      if (answer.kind !== "unavailable") settled = answer;
      return answer;
    },
  };
}
