import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  checkUpstream,
  CHECK_INTERVAL_MS,
  confirmedInstall,
  install,
  installHazard,
  pin,
  status,
  syncEntry,
  uninstall,
  unpin,
  update,
  type Confirmer,
  type Lifecycle,
} from "../../src/lifecycle.ts";
import { entryStatus } from "../../src/mcp-config.ts";
import {
  EXECUTABLE_NAME,
  managedExecutable,
  mcpConfigPath,
  packageRoot,
  upstreamInstallDir,
} from "../../src/paths.ts";
import { describeTarget, type Target } from "../../src/platform.ts";
import { projectResolver } from "../../src/project.ts";
import { readState, updateState } from "../../src/state.ts";
import { buildArchive, dropBuiltArchives, fakeSource, releaseMembers } from "../support/release.ts";
import { dropScratch, makeScratch, writeFakeExecutable, type Scratch } from "../support/scratch.ts";

import type { GraphClient } from "../../src/graph.ts";
import type { ProjectResolution } from "../../src/project.ts";
import type { ReleaseSource } from "../../src/release.ts";

const TARGET: Target = describeTarget(process.platform === "darwin" ? "darwin" : "linux", "arm64");
const VERSION = "0.10.8";

let scratch: Scratch;

beforeEach(async () => {
  // The lifecycle shells out to `tar`, and on macOS to `xattr` and `codesign`.
  scratch = await makeScratch({ systemTools: true });
});

afterEach(async () => {
  await dropScratch(scratch);
});

// `bun test` never fires `process.on("exit")`, so the archive staging root has
// to be dropped per test file or it outlives the run.
afterAll(() => {
  dropBuiltArchives();
});

/** A release source serving one genuine archive for `version`. */
async function servedSource(version: string): Promise<ReleaseSource> {
  const archive = await buildArchive(TARGET.archive, releaseMembers(TARGET, version));
  return fakeSource({
    tag: `v${version}`,
    archiveName: TARGET.archive,
    bytes: archive.bytes,
    publishedDigest: archive.digest,
  });
}

async function lifecycleFor(version: string): Promise<Lifecycle> {
  return { host: scratch.host, target: TARGET, source: await servedSource(version) };
}

/**
 * A lifecycle whose source serves a genuine archive under a digest that does
 * not match it.
 *
 * The cheapest way to fail an acquisition at the last verification step that
 * still involves the network, an archive and a real `tar` -- which is what a
 * digest mismatch, an unexpected member and a failed smoke check all are from
 * the lifecycle's point of view.
 */
async function mismatchedLifecycleFor(version: string): Promise<Lifecycle> {
  const archive = await buildArchive(TARGET.archive, releaseMembers(TARGET, version));
  return {
    host: scratch.host,
    target: TARGET,
    source: fakeSource({
      tag: `v${version}`,
      archiveName: TARGET.archive,
      bytes: archive.bytes,
      publishedDigest: "0".repeat(64),
    }),
  };
}

/** A source whose every call fails the test: it must never be reached. */
const forbiddenSource: ReleaseSource = {
  latestTag: async () => {
    throw new Error("the network was reached when it should not have been");
  },
  checksums: async () => {
    throw new Error("the network was reached when it should not have been");
  },
  asset: async () => {
    throw new Error("the network was reached when it should not have been");
  },
};

describe("no lifecycle operation writes to ~/.local/bin", () => {
  /**
   * `~/.local/bin` is upstream's install directory. This package reads it -- it
   * is third in the resolution order -- and must never write it: an executable
   * there belongs to CBM's own installer and updater, whose activation path
   * drains sessions and swaps the target transactionally.
   */
  test("running install, sync, check, pin, unpin and uninstall leaves it absent", async () => {
    const lifecycle = await lifecycleFor(VERSION);

    expect((await install(lifecycle)).ok).toBe(true);
    expect((await syncEntry(lifecycle)).kind).toBe("unchanged");
    expect((await checkUpstream(lifecycle, { force: true })).kind).not.toBe("failed");
    expect((await pin(lifecycle, VERSION)).ok).toBe(true);
    expect((await update(lifecycle)).ok).toBe(true);
    expect((await unpin(lifecycle)).ok).toBe(true);
    expect((await status(lifecycle, unindexed)).resolved).not.toBeNull();
    expect((await uninstall(lifecycle)).ok).toBe(true);

    // Positively, by code: a bare `rejects.toThrow()` is satisfied by any
    // rejection, including the ENOTDIR a lifecycle operation would raise by
    // creating `~/.local/bin` as a regular file -- which is the very write this
    // case exists to forbid.
    expect(
      await Bun.file(path.join(upstreamInstallDir(scratch.host), EXECUTABLE_NAME)).exists(),
    ).toBe(false);
    await expect(readdir(upstreamInstallDir(scratch.host))).rejects.toThrow(/ENOENT/u);
  });

  test("an executable already there is neither replaced nor removed", async () => {
    const adopted = path.join(upstreamInstallDir(scratch.host), EXECUTABLE_NAME);
    await writeFakeExecutable(adopted, `echo "codebase-memory-mcp 0.9.0"`);
    const before = await stat(adopted);
    const contents = await Bun.file(adopted).text();

    const lifecycle = await lifecycleFor(VERSION);
    expect((await syncEntry(lifecycle)).kind).toBe("wired");
    // The system copy resolves, so update only reports.
    expect((await update(lifecycle)).message).toContain("is a system installation");
    expect((await uninstall(lifecycle)).ok).toBe(true);

    expect(await Bun.file(adopted).exists()).toBe(true);
    expect(await Bun.file(adopted).text()).toBe(contents);
    expect((await stat(adopted)).mtimeMs).toBe(before.mtimeMs);
  });
});

describe("the update check is rate-limited", () => {
  test("a check recorded under 24 hours ago makes no network request", async () => {
    const now = Date.now();
    await updateState(scratch.host, { lastCheckedAt: now - CHECK_INTERVAL_MS + 60_000 });

    const report = await checkUpstream(
      { host: scratch.host, target: TARGET, source: forbiddenSource },
      { now },
    );
    expect(report.kind).toBe("skipped");
  });

  test("a check recorded over 24 hours ago is performed", async () => {
    const now = Date.now();
    await updateState(scratch.host, { lastCheckedAt: now - CHECK_INTERVAL_MS - 1 });

    const report = await checkUpstream(
      { host: scratch.host, target: TARGET, source: await servedSource("0.11.0") },
      { now },
    );
    expect(report.kind).toBe("newer");
    expect((await readState(scratch.host)).upstreamVersion).toBe("0.11.0");
  });

  test("a check timestamp in the future reads as stale rather than suppressing the check", async () => {
    const now = Date.now();
    // A restored VM snapshot, an NTP step or a bad RTC moves the clock
    // backwards, and a one-sided age test then reads the recorded time as
    // "checked in 30 days' time" and honours it for the whole skew.
    await updateState(scratch.host, { lastCheckedAt: now + 30 * CHECK_INTERVAL_MS });

    const report = await checkUpstream(
      { host: scratch.host, target: TARGET, source: await servedSource("0.11.0") },
      { now },
    );
    expect(report.kind).toBe("newer");
    expect((await readState(scratch.host)).lastCheckedAt).toBe(now);
  });

  /**
   * `acquire` returns the version it was asked for, so recording it as the
   * newest upstream release would report an old build as the newest one and
   * suppress the real check for a day. Only a check establishes that field.
   */
  test("an explicitly requested version is not recorded as the newest upstream release", async () => {
    const report = await install(await lifecycleFor("0.9.0"), "0.9.0");
    expect(report.ok).toBe(true);

    const state = await readState(scratch.host);
    expect(state.managedVersion).toBe("0.9.0");
    expect(state.managedDigest).toBeDefined();
    expect(state.upstreamVersion).toBeUndefined();
    expect(state.lastCheckedAt).toBeUndefined();
  });

  test("a failed check is recorded so a broken network is retried daily, not per session", async () => {
    const now = Date.now();
    const report = await checkUpstream(
      { host: scratch.host, target: TARGET, source: forbiddenSource },
      { now },
    );

    expect(report.kind).toBe("failed");
    expect((await readState(scratch.host)).lastCheckedAt).toBe(now);
  });

  test("a pinned version is reported rather than adopted", async () => {
    const lifecycle = await lifecycleFor(VERSION);
    await install(lifecycle);
    await pin(lifecycle, VERSION);

    const newer = { host: scratch.host, target: TARGET, source: await servedSource("0.11.0") };
    const report = await checkUpstream(newer, { force: true });
    expect(report.kind).toBe("newer");
    expect(report.message).toContain("is pinned");

    // The pin holds: `update` reports and adopts nothing.
    expect((await update(newer)).message).toContain("is pinned");
    expect((await readState(scratch.host)).managedVersion).toBe(VERSION);
  });
});

describe("install wires the MCP entry", () => {
  test("the entry names the adopted absolute path and re-running changes nothing", async () => {
    const lifecycle = await lifecycleFor(VERSION);
    const first = await install(lifecycle);
    expect(first.ok).toBe(true);

    const file = mcpConfigPath(scratch.host);
    const written = await Bun.file(file).text();
    const state = await readState(scratch.host);
    const adopted = path.join(packageRoot(scratch.host), "bin", VERSION, EXECUTABLE_NAME);

    expect(state.wroteCommand).toBe(adopted);
    expect((await entryStatus(scratch.host, adopted)).current).toBe(true);

    expect((await syncEntry(lifecycle)).kind).toBe("unchanged");
    expect(await Bun.file(file).text()).toBe(written);
  });

  test("a managed update moves the entry and says the session needs a reload", async () => {
    await install(await lifecycleFor(VERSION));
    const report = await update(await lifecycleFor("0.11.0"));

    expect(report.ok).toBe(true);
    expect(report.message).toContain("/mcp reload");
    expect((await readState(scratch.host)).managedVersion).toBe("0.11.0");
  });

  /**
   * Asserted through `syncEntry` rather than through `update`, because the
   * discriminant is what the extension entry branches on: `rewired` is notified
   * and `unchanged` is silent. A session that rewrites `mcp.json` to a new
   * version directory and says nothing leaves MCP talking to the previous path
   * for the rest of the session.
   */
  test("session start rewires a drifted entry and reports the discriminant", async () => {
    await install(await lifecycleFor(VERSION));

    const moved = managedExecutable(scratch.host, "0.11.0");
    await writeFakeExecutable(moved, `echo "codebase-memory-mcp 0.11.0"`);
    await updateState(scratch.host, { managedVersion: "0.11.0" });

    const report = await syncEntry({
      host: scratch.host,
      target: TARGET,
      source: forbiddenSource,
    });
    expect(report.kind).toBe("rewired");
    expect(report.message).toContain("/mcp reload");

    const written = JSON.parse(await Bun.file(mcpConfigPath(scratch.host)).text()) as {
      mcpServers: Record<string, { command?: string }>;
    };
    expect(written.mcpServers["codebase-memory-mcp"]?.command).toBe(moved);
  });
});

/**
 * A failed acquisition is the case in which everything already working has to
 * survive: the managed copy resolution falls back to, the operator's pin, the
 * receipt that decides whether the MCP entry is this package's to take back,
 * and the entry itself.
 */
describe("a failed acquisition leaves the working installation alone", () => {
  test("install keeps the managed copy, the pin, the receipt and mcp.json", async () => {
    const lifecycle = await lifecycleFor(VERSION);
    await install(lifecycle);
    await pin(lifecycle, VERSION);

    const file = mcpConfigPath(scratch.host);
    const before = await Bun.file(file).text();
    const recorded = await readState(scratch.host);

    const report = await install(await mismatchedLifecycleFor("0.11.0"), "0.11.0");
    expect(report.ok).toBe(false);
    expect(report.message).toContain("install failed");

    expect(await Bun.file(managedExecutable(scratch.host, VERSION)).exists()).toBe(true);
    const after = await readState(scratch.host);
    expect(after.managedVersion).toBe(VERSION);
    expect(after.pin).toBe(VERSION);
    expect(after.wroteCommand).toBe(recorded.wroteCommand);
    expect(await Bun.file(file).text()).toBe(before);
  });

  test("update keeps the managed copy, the receipt and mcp.json", async () => {
    await install(await lifecycleFor(VERSION));

    const file = mcpConfigPath(scratch.host);
    const before = await Bun.file(file).text();
    const recorded = await readState(scratch.host);

    const report = await update(await mismatchedLifecycleFor("0.11.0"));
    expect(report.ok).toBe(false);

    expect(await Bun.file(managedExecutable(scratch.host, VERSION)).exists()).toBe(true);
    const after = await readState(scratch.host);
    expect(after.managedVersion).toBe(VERSION);
    expect(after.wroteCommand).toBe(recorded.wroteCommand);
    expect(await Bun.file(file).text()).toBe(before);
  });
});

describe("uninstall", () => {
  test("removes the managed copy, its state, and the owned entry", async () => {
    const lifecycle = await lifecycleFor(VERSION);
    await install(lifecycle);

    const report = await uninstall(lifecycle);
    expect(report.ok).toBe(true);
    expect(report.message).toContain("removed the owned MCP entry");
    expect(await Bun.file(packageRoot(scratch.host)).exists()).toBe(false);
    expect((await entryStatus(scratch.host, null)).present).toBe(false);
  });

  test("leaves an unrelated MCP server in place", async () => {
    const lifecycle = await lifecycleFor(VERSION);
    await install(lifecycle);

    const file = mcpConfigPath(scratch.host);
    const document = JSON.parse(await Bun.file(file).text()) as {
      mcpServers: Record<string, unknown>;
    };
    document.mcpServers["filesystem"] = { command: "npx", args: [] };
    await Bun.write(file, `${JSON.stringify(document, null, 2)}\n`);

    await uninstall(lifecycle);

    const after = JSON.parse(await Bun.file(file).text()) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(after.mcpServers)).toEqual(["filesystem"]);
  });

  test("succeeds when nothing was ever installed", async () => {
    const report = await uninstall({ host: scratch.host, target: TARGET, source: forbiddenSource });
    expect(report.ok).toBe(true);
    expect(report.message).toContain("no managed copy was present");
  });

  /**
   * The two halves go together only when keeping the entry would leave it
   * naming a file this command deleted. A file this package cannot read is that
   * case: it cannot know what the entry names, and deleting the managed copy
   * plus the state that identifies it would leave nothing able to reclaim the
   * key either. Removing neither half is recoverable; removing only one is not.
   */
  test("an unreadable file keeps the managed copy and the state that identifies it", async () => {
    const lifecycle = await lifecycleFor(VERSION);
    await install(lifecycle);

    const file = mcpConfigPath(scratch.host);
    const unparseable = '{ "mcpServers": { "codebase-memory-mcp": ';
    await Bun.write(file, unparseable);

    const report = await uninstall(lifecycle);
    expect(report.ok).toBe(false);
    expect(report.message).toMatch(/not parseable JSON/u);
    expect(report.message).toContain("were kept");

    expect(await Bun.file(managedExecutable(scratch.host, VERSION)).exists()).toBe(true);
    expect((await readState(scratch.host)).managedVersion).toBe(VERSION);
    expect(await Bun.file(file).text()).toBe(unparseable);
  });

  /**
   * A refused entry naming a system CBM is a different case entirely: it is
   * correctly wired to an executable this command never touches, so nothing
   * dangles when the managed copy goes. Blocking here would make the managed
   * copy unremovable by the one command whose job is removing it, and would
   * tell the operator to re-point an entry that is already right.
   */
  test("a foreign entry naming a system path still lets the managed copy go", async () => {
    const lifecycle = await lifecycleFor(VERSION);
    await install(lifecycle);

    const file = mcpConfigPath(scratch.host);
    const foreign = `{\n  "mcpServers": {\n    "codebase-memory-mcp": {\n      "command": "/usr/local/bin/codebase-memory-mcp"\n    }\n  }\n}\n`;
    await Bun.write(file, foreign);

    const report = await uninstall(lifecycle);
    expect(report.ok).toBe(true);
    expect(report.message).toContain(`removed the managed copy of ${VERSION}`);
    expect(report.message).toContain("left the MCP entry alone");
    expect(report.message).toContain("/usr/local/bin/codebase-memory-mcp");

    expect(await Bun.file(packageRoot(scratch.host)).exists()).toBe(false);
    expect(await Bun.file(file).text()).toBe(foreign);
  });

  /**
   * The graph belongs to CBM and is shared with every other client configured
   * on the account, so removing this package must not remove an index some
   * other editor is using.
   *
   * Checked from both ends. Behaviourally: the project list the resolver
   * reports is identical before and after, and `uninstall` made no graph call
   * at all. And by name: `delete_project` exists in CBM's tool surface, so the
   * assertion that this package never calls it is worth making where a future
   * "tidy up on uninstall" would have to add it.
   */
  test("deletes no indexed project, and does not so much as ask the graph", async () => {
    const lifecycle = await lifecycleFor(VERSION);
    await install(lifecycle);

    const asked: string[] = [];
    const client: GraphClient = {
      call: async (tool) => {
        asked.push(tool);
        return tool === "list_projects" ? { projects: [{ name: "app", root_path: scratch.home }] } : null;
      },
      toolNames: async () => null,
      close: () => {},
    };

    const before = await projectResolver(client, scratch.home).resolve();
    asked.length = 0;

    expect((await uninstall(lifecycle)).ok).toBe(true);

    expect(asked).toEqual([]);
    expect(await projectResolver(client, scratch.home).resolve()).toEqual(before);
  });

  test("no lifecycle module names CBM's project-deleting tool", async () => {
    const modules = ["src/lifecycle.ts", "src/index.ts", "src/augment.ts", "src/augment-entry.ts", "src/project.ts"];
    for (const module of modules) {
      const source = await Bun.file(path.resolve(import.meta.dir, "..", "..", module)).text();
      expect(source).not.toContain("delete_project");
    }
  });
});

describe("status", () => {
  test("reports a managed copy that is present but not resolved", async () => {
    await install(await lifecycleFor(VERSION));
    await writeFakeExecutable(
      path.join(scratch.pathDir, EXECUTABLE_NAME),
      `echo "codebase-memory-mcp 0.9.0"`,
    );

    const report = await status({ host: scratch.host, target: TARGET, source: forbiddenSource }, unindexed);
    const text = report.lines.join("\n");

    expect(text).toContain("source:     system (PATH)");
    expect(text).toContain(`managed:    ${VERSION}`);
    expect(text).toContain("(present, not resolved)");
  });

  test("names the resolved agent directory so a profile-scoped write is visible", async () => {
    const report = await status({ host: scratch.host, target: TARGET, source: forbiddenSource }, unindexed);
    expect(report.lines.join("\n")).toContain(`agent dir:  ${path.join(scratch.home, ".omp/agent")}`);
  });

  test("does not consult the graph when nothing resolves, and says so", async () => {
    let consulted = 0;
    const report = await status({ host: scratch.host, target: TARGET, source: forbiddenSource }, async () => {
      consulted += 1;
      return { kind: "unindexed" };
    });

    expect(consulted).toBe(0);
    expect(report.lines.join("\n")).toContain("index:      not checked (no executable resolved)");
  });
});

/**
 * The index lines status reports, over each answer the probe can give.
 *
 * The probe is the seam the real graph client sits behind, so the reported
 * shape is checkable without a CBM executable -- and "an unindexed directory is
 * not an error" is a property of the text, which is exactly what an operator
 * reads.
 */
interface IndexCase {
  readonly scenario: string;
  readonly probed: ProjectResolution;
  readonly expected: readonly string[];
  /** A line that must not appear, so a plain report cannot drift into an error. */
  readonly absent?: string;
}

const indexCases: IndexCase[] = [
  {
    scenario: "a covered directory reports the project name and its recorded root",
    probed: { kind: "project", project: { name: "graph-project", root: "/work/graph-project" } },
    expected: ["index:      graph-project", "index root: /work/graph-project"],
  },
  {
    scenario: "an uncovered directory is reported plainly rather than as an error",
    probed: { kind: "unindexed" },
    expected: ["index:      this directory is not covered by an indexed project"],
    absent: "error",
  },
  {
    scenario: "an empty graph reads the same as no match, because it is the same state",
    probed: { kind: "unindexed" },
    expected: ["index:      this directory is not covered by an indexed project"],
  },
  {
    scenario: "a graph that did not answer is reported as unknown",
    probed: { kind: "unavailable" },
    expected: ["index:      unknown (the graph did not answer)"],
  },
];

test.each(indexCases)("$scenario", async ({ probed, expected, absent }) => {
  await writeFakeExecutable(path.join(scratch.pathDir, EXECUTABLE_NAME), `echo "codebase-memory-mcp ${VERSION}"`);

  const report = await status(
    { host: scratch.host, target: TARGET, source: forbiddenSource },
    async () => probed,
  );
  const text = report.lines.join("\n");

  for (const line of expected) expect(text).toContain(line);
  if (absent !== undefined) expect(text.toLowerCase()).not.toContain(absent);
});

test("the resolver behind status and the augmentation is one implementation, reused in a session", async () => {
  await writeFakeExecutable(path.join(scratch.pathDir, EXECUTABLE_NAME), `echo "codebase-memory-mcp ${VERSION}"`);

  // One `list_projects` answer, one resolver, two consumers: whatever status
  // reports is the same object the augmentation would have queried with.
  let listed = 0;
  const client: GraphClient = {
    call: async (tool) => {
      if (tool !== "list_projects") return null;
      listed += 1;
      return { projects: [{ name: "graph-project", root_path: scratch.home }] };
    },
    toolNames: async () => null,
    close: () => {},
  };
  const resolver = projectResolver(client, path.join(scratch.home, "nested", "dir"));

  const report = await status({ host: scratch.host, target: TARGET, source: forbiddenSource }, async () =>
    await resolver.resolve(),
  );
  const forAugmentation = await resolver.resolve();

  expect(listed).toBe(1);
  expect(report.lines.join("\n")).toContain("index:      graph-project");
  expect(forAugmentation).toEqual({ kind: "project", project: { name: "graph-project", root: scratch.home } });
});

/** The probe every status test that is not about index state passes. */
const unindexed = async (): Promise<ProjectResolution> => ({ kind: "unindexed" });

/** A confirmer whose answer is fixed, recording whether it was consulted. */
function fixedConfirmer(available: boolean, answer: boolean): Confirmer & { asked: string[] } {
  const asked: string[] = [];
  return {
    available,
    asked,
    ask: async (_title, message) => {
      asked.push(message);
      return answer;
    },
  };
}

describe("install is gated on confirmation when a system copy already resolves", () => {
  test("with nothing resolving there is no hazard and no question is asked", async () => {
    const confirmer = fixedConfirmer(true, false);
    expect(await installHazard(await lifecycleFor(VERSION))).toBeNull();

    const report = await confirmedInstall(await lifecycleFor(VERSION), undefined, confirmer);
    expect(report.ok).toBe(true);
    expect(confirmer.asked).toEqual([]);
    expect((await readState(scratch.host)).managedVersion).toBe(VERSION);
  });

  test("the hazard names the resolved executable and the shared cache root", async () => {
    await writeFakeExecutable(
      path.join(scratch.pathDir, EXECUTABLE_NAME),
      `echo "codebase-memory-mcp 0.9.0"`,
    );

    const hazard = await installHazard(await lifecycleFor(VERSION));
    expect(hazard).toContain(path.join(scratch.pathDir, EXECUTABLE_NAME));
    expect(hazard).toContain("one canonical cache root per account");
  });

  test("declining downloads nothing", async () => {
    await writeFakeExecutable(
      path.join(scratch.pathDir, EXECUTABLE_NAME),
      `echo "codebase-memory-mcp 0.9.0"`,
    );
    const confirmer = fixedConfirmer(true, false);

    const report = await confirmedInstall(await lifecycleFor(VERSION), undefined, confirmer);
    expect(report.ok).toBe(true);
    expect(report.message).toContain("Nothing was downloaded");
    expect(confirmer.asked).toHaveLength(1);
    expect(await Bun.file(packageRoot(scratch.host)).exists()).toBe(false);
  });

  test("accepting downloads and adopts a second copy", async () => {
    await writeFakeExecutable(
      path.join(scratch.pathDir, EXECUTABLE_NAME),
      `echo "codebase-memory-mcp 0.9.0"`,
    );
    const confirmer = fixedConfirmer(true, true);

    const report = await confirmedInstall(await lifecycleFor(VERSION), undefined, confirmer);
    expect(report.ok).toBe(true);
    expect(confirmer.asked).toHaveLength(1);
    expect((await readState(scratch.host)).managedVersion).toBe(VERSION);
  });

  /**
   * The spec is explicit that no command may block on input that cannot arrive.
   * A session with no interactive UI must therefore report the hazard and stop.
   */
  test("with no interactive UI it reports the reason and never asks", async () => {
    await writeFakeExecutable(
      path.join(scratch.pathDir, EXECUTABLE_NAME),
      `echo "codebase-memory-mcp 0.9.0"`,
    );
    const confirmer = fixedConfirmer(false, true);

    const report = await confirmedInstall(await lifecycleFor(VERSION), undefined, confirmer);
    expect(report.ok).toBe(false);
    expect(report.message).toContain("no interactive UI");
    expect(report.message).toContain("nothing was downloaded");
    expect(confirmer.asked).toEqual([]);
    expect(await Bun.file(packageRoot(scratch.host)).exists()).toBe(false);
  });
});

describe("session start with nothing resolving", () => {
  test("writes no entry and names the install command", async () => {
    const report = await syncEntry({
      host: scratch.host,
      target: TARGET,
      source: forbiddenSource,
    });

    expect(report.kind).toBe("unresolved");
    expect(report.message).toContain("/cbm install");
    expect(report.message).toContain("No MCP entry was written or changed");
    expect(await Bun.file(mcpConfigPath(scratch.host)).exists()).toBe(false);
  });

  test("a pre-existing foreign entry is refused rather than corrected", async () => {
    const file = mcpConfigPath(scratch.host);
    const foreign = `{\n  "mcpServers": {\n    "codebase-memory-mcp": {\n      "command": "/opt/homebrew/bin/codebase-memory-mcp"\n    }\n  }\n}\n`;
    await Bun.write(file, foreign);
    await writeFakeExecutable(
      path.join(scratch.pathDir, EXECUTABLE_NAME),
      `echo "codebase-memory-mcp 0.9.0"`,
    );

    const report = await syncEntry({
      host: scratch.host,
      target: TARGET,
      source: forbiddenSource,
    });

    expect(report.kind).toBe("refused");
    expect(report.message).toContain("/opt/homebrew/bin/codebase-memory-mcp");
    expect(await Bun.file(file).text()).toBe(foreign);
  });
});
