import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { COMMAND_TIMEOUT_MS } from "../../src/graph.ts";
import { CHECK_DELAY_MS, deferChecks, indexProbe } from "../../src/index.ts";
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
  agentDir,
  EXECUTABLE_NAME,
  managedExecutable,
  mcpConfigPath,
  packageRoot,
  upstreamInstallDir,
} from "../../src/paths.ts";
import { describeTarget, type Target } from "../../src/platform.ts";
import { readState, updateState } from "../../src/state.ts";
import { writeFakeGraph } from "../support/fake-graph.ts";
import { buildArchive, dropBuiltArchives, fakeSource, releaseMembers } from "../support/release.ts";
import { dropScratch, makeScratch, writeFakeExecutable, type Scratch } from "../support/scratch.ts";

import type { ProjectResolution } from "../../src/project.ts";
import type { ReleaseSource } from "../../src/release.ts";
import type { Scheduler, TimerHandle } from "../../src/scheduler.ts";

const TARGET: Target = describeTarget(process.platform === "darwin" ? "darwin" : "linux", "arm64");
const VERSION = "0.10.8";

/**
 * The budget for a test that spawns the fake graph server.
 *
 * Two subprocess starts through a `#!/usr/bin/env bun` shebang plus a
 * deliberately slow handshake, against Bun's 5 s default. Generous enough that a
 * timeout means something hung rather than that the runner was loaded.
 */
const SLOW_SPAWN_MS = 30_000;

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
   * Checked as a boundary rather than as an absence. `uninstall` takes no graph
   * client, so "it made no graph call" is a fact about its signature and cannot
   * fail; what can fail is the `rm`, which today names this package's own root
   * and would name a cache root or the agent directory the moment someone
   * widened it to "tidy up". So the test puts a file in each of the places
   * CBM's own data lives and asserts they all outlive the uninstall.
   */
  test("removes its own root and nothing CBM owns", async () => {
    const lifecycle = await lifecycleFor(VERSION);
    await install(lifecycle);

    // Each of these is a place CBM's own data lives, and none is under the root
    // this command deletes: the cache holding the shared index, the agent
    // directory holding other extensions' configuration, and upstream's own
    // install directory holding an executable this package only ever adopts.
    const foreign = [
      path.join(scratch.home, ".cache", "codebase-memory", "graph.db"),
      path.join(agentDir(scratch.host), "another-extension.json"),
      path.join(upstreamInstallDir(scratch.host), EXECUTABLE_NAME),
    ];
    for (const file of foreign) await Bun.write(file, "belongs to something else");

    expect((await uninstall(lifecycle)).ok).toBe(true);

    expect(await Bun.file(packageRoot(scratch.host)).exists()).toBe(false);
    for (const file of foreign) expect(await Bun.file(file).exists()).toBe(true);
  });

  /**
   * Two tools this package must never call, refused by name in every module
   * that could plausibly grow a call to one.
   *
   * `delete_project` would remove an index shared with every other client on the
   * account. `index_repository` is the other half of the same rule and had no
   * guard: CBM exposes it to the agent, the shipped skill and rule point the
   * agent at it, and a lifecycle command that indexed on the operator's behalf
   * would duplicate an action the MCP surface already offers -- with none of the
   * agent's judgement about what is worth indexing.
   */
  test("no lifecycle module names CBM's project-deleting or repository-indexing tool", async () => {
    const modules = ["src/lifecycle.ts", "src/index.ts", "src/augment.ts", "src/augment-entry.ts", "src/project.ts"];
    const refused = ["delete_project", "index_repository"];

    const violations: string[] = [];
    for (const module of modules) {
      const source = await Bun.file(path.resolve(import.meta.dir, "..", "..", module)).text();
      for (const tool of refused) if (source.includes(tool)) violations.push(`${module}: ${tool}`);
    }

    expect(violations).toEqual([]);
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

/**
 * The probe `/cbm status` actually uses, against a server that makes it wait.
 *
 * This is the one that was missing, and its absence is why the command shipped
 * unable to answer. Every case above injects a probe, so the shape of the
 * report was covered and the thing producing it was not: the real probe opened
 * a session and asked immediately, a query deliberately refuses to wait for a
 * handshake, and the handshake takes ~2.9 s warm against the real executable --
 * so status could only ever print the third branch, "the graph did not answer".
 *
 * The fake's handshake delay is far longer than the 300 ms query deadline, so a
 * probe that does not wait for readiness fails this deterministically rather
 * than by timing.
 */
test("the real probe resolves the project against a server whose handshake outlasts a query deadline", async () => {
  const graph = path.join(scratch.root, "graph-server");
  await writeFakeGraph(graph, {
    handshakeDelayMs: 700,
    toolNames: ["list_projects", "search_graph"],
    tools: { list_projects: { projects: [{ name: "graph-project", root_path: scratch.home }] } },
  });

  const resolved = await indexProbe(path.join(scratch.home, "nested", "dir"), () => {})(graph);

  expect(resolved).toEqual({ kind: "project", project: { name: "graph-project", root: scratch.home } });
}, SLOW_SPAWN_MS);

/**
 * The same probe against a wedged daemon, which is where it used to freeze.
 *
 * Waiting for readiness is what makes the probe able to answer at all, and it is
 * also what put two 20 s deadlines in front of an operator: `toolNames()` waits
 * for `initialize` and then asks `tools/list`, both charged the handshake
 * ceiling that was chosen for a background warm-up where nobody waits. Measured
 * against this same fake before the shared budget: 20,003 ms to answer
 * `{"kind":"unavailable"}` for a typed `/cbm status`, where a working server
 * answers in ~360 ms. The trigger is a CBM daemon that accepted a connection and
 * stopped responding, which is exactly the condition the reopen path exists for.
 *
 * The elapsed time is asserted, because the return value alone was already
 * correct at 20 s. The debug line is asserted with it: it names the deadline the
 * client actually enforced, so this fails loudly rather than by timing if the
 * budget stops reaching the handshake. The upper bound has 5 s of slack for a
 * loaded runner's spawn and still separates 10 s from the 20 s it replaced.
 */
test("a typed status against a server that never hand shakes answers inside the command budget", async () => {
  const graph = path.join(scratch.root, "wedged-server");
  await writeFakeGraph(graph, { handshakeDelayMs: 120_000, toolNames: ["list_projects"] });
  const debugLines: string[] = [];

  const started = performance.now();
  const resolved = await indexProbe(scratch.home, (message) => debugLines.push(message))(graph);
  const elapsed = performance.now() - started;

  expect(resolved).toEqual({ kind: "unavailable" });
  expect(debugLines).toContain(`graph query initialize exceeded ${COMMAND_TIMEOUT_MS}ms`);
  expect(elapsed).toBeLessThan(COMMAND_TIMEOUT_MS + 5_000);
}, SLOW_SPAWN_MS);

/**
 * The same probe, reached the way the command reaches it.
 *
 * The fake answers `--version` as well as speaking stdio, so it is the resolved
 * executable rather than a seam beside one: what this asserts is the two lines
 * an operator actually reads.
 */
test("status names the project and its recorded root, from the probe the command passes", async () => {
  await writeFakeGraph(path.join(scratch.pathDir, EXECUTABLE_NAME), {
    version: VERSION,
    handshakeDelayMs: 700,
    toolNames: ["list_projects"],
    tools: { list_projects: { projects: [{ name: "graph-project", root_path: scratch.home }] } },
  });

  const report = await status(
    { host: scratch.host, target: TARGET, source: forbiddenSource },
    indexProbe(scratch.home, () => {}),
  );
  const text = report.lines.join("\n");

  expect(text).toContain("index:      graph-project");
  expect(text).toContain(`index root: ${scratch.home}`);
  expect(text).toContain(`version:    codebase-memory-mcp ${VERSION}`);
}, SLOW_SPAWN_MS);

/**
 * A timer handle that is not a timer.
 *
 * `Scheduler.after` answers with OMP's managed handle type, and the test below
 * runs the callback itself rather than letting a clock do it, so the handle only
 * has to exist. Structural, so nothing is scheduled and nothing has to be
 * cancelled.
 */
const INERT_TIMER: TimerHandle = {
  ref: () => INERT_TIMER,
  unref: () => INERT_TIMER,
  hasRef: () => false,
  refresh: () => INERT_TIMER,
  [Symbol.toPrimitive]: () => 0,
};

/**
 * The two deferred checks never sit between the operator and a usable session.
 *
 * `graph-augmentation "Scenario: Check does not delay session start"` requires
 * the tool-surface check to run off the blocking path with a result that gates
 * nothing, and the version check is a network request. So scheduling them must
 * consult neither the network nor the executable -- the release source here
 * throws on any call, and it is not reached until the callback is run by hand.
 *
 * The second half is what "never gates readiness" means when a check fails: the
 * failure lands in the debug sink, not on the operator and not on the session's
 * error channel. Awaited through the sink rather than after a delay, because the
 * sink is the signal the code already exposes.
 */
test("the deferred checks are scheduled rather than run, and a failure stays in the log", async () => {
  const scheduled: { callback: () => void; ms: number }[] = [];
  const scheduler: Scheduler = {
    after: (callback, ms) => {
      scheduled.push({ callback, ms });
      return INERT_TIMER;
    },
    cancel: () => {},
  };

  const notices: string[] = [];
  const recorded = Promise.withResolvers<string>();
  deferChecks({ host: scratch.host, target: TARGET, source: forbiddenSource }, scheduler, {
    notify: (message) => notices.push(message),
    debug: (message) => recorded.resolve(message),
  });

  // Nothing has run: the source that would have thrown was never consulted.
  expect(scheduled).toHaveLength(1);
  const deferred = scheduled[0];
  expect(deferred?.ms).toBe(CHECK_DELAY_MS);

  deferred?.callback();

  expect(await recorded.promise).toContain("the network was reached");
  expect(notices).toEqual([]);
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
