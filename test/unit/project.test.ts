import { expect, test } from "bun:test";
import path from "node:path";

import { projectResolver, readProjects, selectProject } from "../../src/project.ts";

import type { GraphClient } from "../../src/graph.ts";
import type { IndexedProject } from "../../src/project.ts";

/**
 * Working directory to project name, which every graph query needs and a
 * session does not have.
 *
 * `selectProject` is pure, so the cases below are the whole decision: the graph
 * supplies the list and the directory supplies the question.
 */

/** A project as `list_projects` records one. */
const project = (name: string, root: string): IndexedProject => ({ name, root });

interface SelectCase {
  readonly scenario: string;
  readonly projects: readonly IndexedProject[];
  readonly cwd: string;
  /** The name expected, or `null` when nothing should match. */
  readonly expected: string | null;
}

const selectCases: SelectCase[] = [
  {
    scenario: "a recorded root that is an ancestor of the working directory matches",
    projects: [project("app", "/work/app")],
    cwd: "/work/app/src/deep",
    expected: "app",
  },
  {
    scenario: "a recorded root equal to the working directory matches",
    projects: [project("app", "/work/app")],
    cwd: "/work/app",
    expected: "app",
  },
  {
    scenario: "the longer of two containing roots wins, so a nested project beats its parent",
    projects: [project("outer", "/work"), project("inner", "/work/app")],
    cwd: "/work/app/src",
    expected: "inner",
  },
  {
    scenario: "the longer root wins regardless of the order the graph listed them in",
    projects: [project("inner", "/work/app"), project("outer", "/work")],
    cwd: "/work/app/src",
    expected: "inner",
  },
  {
    scenario: "no recorded root containing the working directory means no project",
    projects: [project("elsewhere", "/other/app")],
    cwd: "/work/app",
    expected: null,
  },
  {
    scenario: "an empty project list means no project, exactly like no match",
    projects: [],
    cwd: "/work/app",
    expected: null,
  },
  {
    scenario: "a sibling whose path is a string prefix is not an ancestor",
    projects: [project("app", "/work/app")],
    cwd: "/work/app-v2/src",
    expected: null,
  },
  {
    scenario: "a trailing separator on the recorded root does not change the match",
    projects: [project("app", `/work/app${path.sep}`)],
    cwd: "/work/app/src",
    expected: "app",
  },
  {
    scenario: "an unnormalised working directory is resolved before comparison",
    projects: [project("app", "/work/app")],
    cwd: "/work/app/src/../lib",
    expected: "app",
  },
];

test.each(selectCases)("$scenario", ({ projects, cwd, expected }) => {
  expect(selectProject(projects, cwd)?.name ?? null).toBe(expected);
});

interface ReadCase {
  readonly scenario: string;
  readonly structured: unknown;
  readonly expected: readonly IndexedProject[] | null;
}

const readCases: ReadCase[] = [
  {
    scenario: "a well-formed response yields the projects it names",
    structured: { projects: [{ name: "app", root_path: "/work/app" }] },
    expected: [project("app", "/work/app")],
  },
  { scenario: "an empty list yields an empty result rather than a failure", structured: { projects: [] }, expected: [] },
  { scenario: "a response with no projects key cannot be read", structured: { total: 0 }, expected: null },
  { scenario: "a response that is not an object cannot be read", structured: "projects", expected: null },
  { scenario: "a null response cannot be read", structured: null, expected: null },
  {
    scenario: "an entry missing its root is dropped, because it cannot be matched",
    structured: { projects: [{ name: "app" }, { name: "other", root_path: "/o" }] },
    expected: [project("other", "/o")],
  },
  {
    scenario: "an entry missing its name is dropped, because it cannot be queried",
    structured: { projects: [{ root_path: "/work/app" }, { name: "other", root_path: "/o" }] },
    expected: [project("other", "/o")],
  },
  {
    scenario: "an entry whose name is empty is dropped",
    structured: { projects: [{ name: "", root_path: "/work/app" }] },
    expected: [],
  },
];

test.each(readCases)("$scenario", ({ structured, expected }) => {
  expect(readProjects(structured)).toEqual(expected);
});

/** A client answering `list_projects` with `answer`, counting the calls. */
function countingClient(answer: unknown): GraphClient & { calls: () => number } {
  let calls = 0;
  return {
    call: async (tool) => {
      if (tool !== "list_projects") return null;
      calls += 1;
      return answer;
    },
    toolNames: async () => null,
    close: () => {},
    calls: () => calls,
  };
}

test("the graph is asked once per session and the answer is reused", async () => {
  const client = countingClient({ projects: [{ name: "app", root_path: "/work/app" }] });
  const resolver = projectResolver(client, "/work/app/src");

  const first = await resolver.resolve();
  const second = await resolver.resolve();

  expect(first).toEqual({ kind: "project", project: project("app", "/work/app") });
  expect(second).toEqual(first);
  expect(client.calls()).toBe(1);
});

test("concurrent resolutions share one query rather than racing two", async () => {
  const client = countingClient({ projects: [{ name: "app", root_path: "/work/app" }] });
  const resolver = projectResolver(client, "/work/app");

  const [first, second] = await Promise.all([resolver.resolve(), resolver.resolve()]);

  expect(first).toEqual(second);
  expect(client.calls()).toBe(1);
});

test("an unreadable answer resolves to unavailable and is not retried", async () => {
  const client = countingClient({ nothing: true });
  const resolver = projectResolver(client, "/work/app");

  expect(await resolver.resolve()).toEqual({ kind: "unavailable" });
  expect(await resolver.resolve()).toEqual({ kind: "unavailable" });
  // Once: the client tears its session down on a missed deadline, so retrying
  // would pay the startup cost again against a session that stopped answering.
  expect(client.calls()).toBe(1);
});

test("a directory outside every recorded root resolves to unindexed, not an error", async () => {
  const resolver = projectResolver(countingClient({ projects: [{ name: "app", root_path: "/work/app" }] }), "/tmp/x");
  expect(await resolver.resolve()).toEqual({ kind: "unindexed" });
});
