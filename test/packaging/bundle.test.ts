import { describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";

import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent";

/**
 * The committed bundles, loaded the way OMP loads them.
 *
 * `test:packaging` rebuilds them first, so a green run here proves a fresh
 * bundle builds and registers what it claims. It says nothing about whether the
 * *committed* files match the source beside them -- that is the
 * `git diff --exit-code` step in CI, and the two checks are not substitutes for
 * each other.
 */

const MANIFEST = "package.json";
const BASE_BUNDLE = "dist/index.js";
const FEATURE = "graph-augmentation";
const FEATURE_BUNDLE = "dist/augment.js";

interface Manifest {
  readonly omp?: {
    readonly extensions?: readonly string[];
    readonly features?: Readonly<
      Record<string, { readonly default?: boolean; readonly extensions?: readonly string[] }>
    >;
  };
}

const manifest = (await Bun.file(MANIFEST).json()) as Manifest;

/** Entries loaded for every install, feature selection notwithstanding. */
const baseEntries = manifest.omp?.extensions ?? [];

/** Entries a feature contributes, which is the whole of its gating mechanism. */
const featureEntries = Object.values(manifest.omp?.features ?? {}).flatMap((feature) => feature.extensions ?? []);

/**
 * Loads one bundle from a directory holding nothing else.
 *
 * The isolation is the point, and it has two halves. The module half: a bundle
 * that had quietly kept a runtime dependency would fail to import rather than
 * resolve it from this repository's own `node_modules`. The environment half:
 * loading *runs* the factory, which stands down when
 * `<agent-dir>/extensions/codebase-memory.ts` exists, so against the
 * developer's real agent directory every assertion below is decided by state
 * outside this repository -- and would go red the day upstream ships the native
 * extension that guard exists to detect, for a reason having nothing to do with
 * the bundle. The scratch directory is the agent directory too; it holds the one
 * bundle under test and nothing else, which is what the assertion below proves.
 */
async function loadIsolated(bundle: string): Promise<LoadExtensionsResult> {
  const directory = await mkdtemp(join(tmpdir(), "cbm-bundle-"));
  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  try {
    const copied = join(directory, basename(bundle));
    await copyFile(resolve(bundle), copied);
    expect(await readdir(directory)).toEqual([basename(bundle)]);

    process.env["PI_CODING_AGENT_DIR"] = directory;
    return await loadExtensions([copied], directory);
  } finally {
    // Restored, not deleted: an unset variable and one set to something else
    // are different environments, and the suite has no licence to change which
    // one the tests after it run in.
    if (previousAgentDir === undefined) {
      delete process.env["PI_CODING_AGENT_DIR"];
    } else {
      process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
    }
    // The loaded module is already in memory, so the copy on disk has no
    // reader left. Every call here makes a directory; none of them outlive it.
    await rm(directory, { recursive: true, force: true });
  }
}

/** The handler names one bundle registers, sorted. */
async function handlersOf(bundle: string): Promise<readonly string[]> {
  const loaded = await loadIsolated(bundle);
  expect(loaded.errors).toEqual([]);
  expect(loaded.extensions).toHaveLength(1);
  return [...(loaded.extensions[0]?.handlers.keys() ?? [])].sort();
}

describe("the declared extension entries", () => {
  test("the augmentation is a feature entry, not a base one, which is what gates it", () => {
    expect(baseEntries).toEqual([`./${BASE_BUNDLE}`]);
    expect(manifest.omp?.features?.[FEATURE]?.extensions).toEqual([`./${FEATURE_BUNDLE}`]);
  });

  test("the augmentation feature declares an explicit default", () => {
    // Present and boolean, not merely truthy: `undefined` means "off unless
    // asked for", and that would be a decision made by omission.
    expect(typeof manifest.omp?.features?.[FEATURE]?.default).toBe("boolean");
  });

  test("every declared entry resolves on disk in the built tree", async () => {
    const entries = [...baseEntries, ...featureEntries];
    expect(entries.length).toBe(2);

    for (const entry of entries) {
      expect(await Bun.file(resolve(entry)).exists()).toBe(true);
    }
  });

  test("every declared entry default-exports a factory function", async () => {
    const entries = [...baseEntries, ...featureEntries];
    expect(entries.length).toBe(2);

    for (const entry of entries) {
      // Dynamic by necessity: the specifier is whatever the manifest declares,
      // which is the thing under test. A static import would check a literal
      // this test wrote instead of the entry OMP's installer will resolve.
      const module = (await import(resolve(entry))) as { default?: unknown };
      expect(typeof module.default).toBe("function");
    }
  });
});

describe("the base bundle", () => {
  test("loads through OMP's own loader with no errors", async () => {
    const loaded = await loadIsolated(BASE_BUNDLE);
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);
  });

  test("registers the /cbm command and no tools", async () => {
    const loaded = await loadIsolated(BASE_BUNDLE);
    expect([...(loaded.extensions[0]?.commands.keys() ?? [])]).toEqual(["cbm"]);
    expect([...(loaded.extensions[0]?.tools.keys() ?? [])]).toEqual([]);
  });

  /**
   * The load-bearing negative. OMP treats a throwing or blocking `tool_call`
   * handler as a refusal of the tool call, so a handler registered there could
   * deny an operator's `grep` because a subprocess timed out. The event is not
   * registered by either entry, and this is the assertion that keeps it that
   * way.
   *
   * Asserted as the whole registered set rather than as
   * `not.toContain("tool_call")`: that form also passes on an *empty* handler
   * list, so it would report success for a factory that registered nothing.
   */
  test("registers only session_start, and no tool handler at all", async () => {
    expect(await handlersOf(BASE_BUNDLE)).toEqual(["session_start"]);
  });
});

describe("the feature bundle", () => {
  test("registers the tool_result handler and the shutdown that releases its graph session", async () => {
    expect(await handlersOf(FEATURE_BUNDLE)).toEqual(["session_shutdown", "tool_result"]);
  });

  test("registers no command and no tools, because it is one handler and nothing else", async () => {
    const loaded = await loadIsolated(FEATURE_BUNDLE);
    expect([...(loaded.extensions[0]?.commands.keys() ?? [])]).toEqual([]);
    expect([...(loaded.extensions[0]?.tools.keys() ?? [])]).toEqual([]);
  });
});

/**
 * The shipped context surfaces, asserted on the built tree.
 *
 * A packaging change can drop a whole directory without changing a single file
 * in it, so the paths are read from the provenance record and checked where an
 * installer would find them.
 */
describe("the shipped context artifacts", () => {
  interface Provenance {
    readonly generated: readonly string[];
  }

  test("the skill, the rule, and all three agents are present at their specified paths", async () => {
    const provenance = (await Bun.file("harvest.json").json()) as Provenance;
    const expected = [
      "agents/codebase-memory-auditor.md",
      "agents/codebase-memory-scout.md",
      "agents/codebase-memory.md",
      "rules/codebase-memory.md",
      "skills/codebase-memory/SKILL.md",
    ];

    for (const relative of expected) {
      expect(provenance.generated).toContain(relative);
      expect(await Bun.file(resolve(relative)).exists()).toBe(true);
    }
  });
});
