import { describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";

import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent";

/**
 * The committed bundle, loaded the way OMP loads it.
 *
 * `test:packaging` rebuilds `dist/index.js` first, so a green run here proves a
 * fresh bundle builds and registers what it claims. It says nothing about
 * whether the *committed* file matches the source beside it -- that is the
 * `git diff --exit-code -- dist/index.js` step in CI, and the two checks are
 * not substitutes for each other.
 */

const MANIFEST = "package.json";
const BUNDLE = "dist/index.js";

interface Manifest {
  readonly omp?: { readonly extensions?: readonly string[] };
}

async function declaredEntries(): Promise<readonly string[]> {
  const manifest = (await Bun.file(MANIFEST).json()) as Manifest;
  return manifest.omp?.extensions ?? [];
}

/**
 * Loads the bundle from a directory holding nothing else.
 *
 * The isolation is the point, and it has two halves. The module half: a bundle
 * that had quietly kept a runtime dependency would fail to import rather than
 * resolve it from this repository's own `node_modules`. The environment half:
 * loading *runs* the factory, which stands down when
 * `<agent-dir>/extensions/codebase-memory.ts` exists, so against the
 * developer's real agent directory every assertion below is decided by state
 * outside this repository -- and would go red the day upstream ships the
 * native extension that guard exists to detect, for a reason having nothing to
 * do with the bundle. The scratch directory is the agent directory too; it
 * holds `index.js` and nothing else, which is what the assertion below proves.
 */
async function loadIsolated(): Promise<LoadExtensionsResult> {
  const directory = await mkdtemp(join(tmpdir(), "cbm-bundle-"));
  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  try {
    const copied = join(directory, "index.js");
    await copyFile(resolve(BUNDLE), copied);
    expect(await readdir(directory)).toEqual(["index.js"]);

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

describe("the declared extension entries", () => {
  test("every omp.extensions entry resolves on disk in the built tree", async () => {
    const entries = await declaredEntries();
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      expect(await Bun.file(resolve(entry)).exists()).toBe(true);
    }
  });

  test("every declared entry default-exports a factory function", async () => {
    const entries = await declaredEntries();
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      // Dynamic by necessity: the specifier is whatever the manifest declares,
      // which is the thing under test. A static import would check a literal
      // this test wrote instead of the entry OMP's installer will resolve.
      const module = (await import(resolve(entry))) as { default?: unknown };
      expect(typeof module.default).toBe("function");
    }
  });
});

describe("the standalone bundle", () => {
  test("loads through OMP's own loader with no errors", async () => {
    const loaded = await loadIsolated();
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);
  });

  test("registers the /cbm command and no tools", async () => {
    const loaded = await loadIsolated();
    expect([...(loaded.extensions[0]?.commands.keys() ?? [])]).toEqual(["cbm"]);
    expect([...(loaded.extensions[0]?.tools.keys() ?? [])]).toEqual([]);
  });

  /**
   * The load-bearing negative. OMP treats a throwing or blocking `tool_call`
   * handler as a refusal of the tool call, so a handler registered here could
   * deny an operator's `grep` because a subprocess timed out. The event is not
   * registered at all, and this is the assertion that keeps it that way.
   *
   * Asserted as the whole registered set rather than as
   * `not.toContain("tool_call")`: that form also passes on an *empty* handler
   * list, so it would report success for a factory that registered nothing.
   */
  test("registers no tool_call handler", async () => {
    const loaded = await loadIsolated();
    const handlers = [...(loaded.extensions[0]?.handlers.keys() ?? [])];
    expect(handlers.sort()).toEqual(["session_start"]);
  });
});
