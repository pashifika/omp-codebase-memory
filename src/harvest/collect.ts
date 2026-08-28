import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { run } from "../exec.ts";

import { HarvestError } from "./transform.ts";

/**
 * Driving CBM's own `install` to emit the content this package ships.
 *
 * `install` is CBM's activation path, not a harmless read: it drains active CBM
 * sessions before configuring, and it writes agent configuration into `HOME`. So
 * everything here is about containment -- a temporary `HOME`, an isolated cache
 * root, an explicit client list, and a refusal when a daemon is running.
 */

/**
 * The clients whose emitted shapes this package derives from.
 *
 * `claude` supplies the skill, whose body is usable verbatim. `augment` supplies
 * the instructions file and the parent-handoff agents -- the variant that
 * carries only `name` and `description`, so no frontmatter key has to be
 * stripped and no substitute invented for what it expressed.
 */
export const SOURCE_CLIENTS = ["claude", "augment"] as const;

/**
 * The directories CBM looks for before it will configure a client.
 *
 * A scratch `HOME` detects nothing, so the pipeline creates exactly these two
 * and gets exactly two configured clients. Observed: without them, `install`
 * reports `Detected agents: (none)` and emits nothing at all.
 */
const DETECTION_DIRS = [".claude", ".augment"] as const;

/** Where the skill body is emitted, relative to the temporary `HOME`. */
const SKILL_SOURCE = ".claude/skills/codebase-memory/SKILL.md";

/** Where the durable instruction body is emitted, relative to the temporary `HOME`. */
const RULE_SOURCE = ".augment/rules/codebase-memory.md";

/** Where the parent-handoff agents are emitted, relative to the temporary `HOME`. */
const AGENTS_SOURCE_DIR = ".augment/agents";

/**
 * The agent files expected in {@link AGENTS_SOURCE_DIR}.
 *
 * Both directions are checked. A missing one is a renamed or dropped tier; an
 * extra one is a tier CBM added that this package would otherwise silently not
 * ship, which is the same drift the CI diff exists to catch.
 */
const AGENT_SOURCES = [
  "codebase-memory.md",
  "codebase-memory-scout.md",
  "codebase-memory-auditor.md",
] as const;

/** Whether a CBM daemon is running, or that the question could not be answered. */
export type DaemonState = "active" | "inactive" | "unknown";

/** The line `daemon status` prints when nothing is running. */
const NOT_RUNNING = "daemon: not running";

/**
 * What `daemon status` reports.
 *
 * Anything that is not an explicit "not running" is {@link DaemonState.unknown}
 * rather than inactive, so a changed output shape cannot be read as permission
 * to stop the operator's sessions.
 */
export async function daemonState(executable: string): Promise<DaemonState> {
  const status = await run([executable, "daemon", "status"], { timeoutMs: 30_000 });
  if (!status.ok || status.spawnError !== undefined) return "unknown";
  const reported = `${status.stdout}${status.stderr}`;
  if (reported.includes(NOT_RUNNING)) return "inactive";
  if (reported.includes("daemon: active")) return "active";
  return "unknown";
}

/** The flag that overrides the daemon refusal, named in the refusal itself. */
export const OVERRIDE_FLAG = "--stop-sessions";

/**
 * The refusal a daemon state earns, or `null` when the harvest may proceed.
 *
 * The refusal is the default and proceeding must be asked for, because the
 * consequence lands outside this repository: a contributor running the harvest
 * would close whatever CBM sessions their editors currently hold, as a side
 * effect of regenerating documentation.
 */
export function daemonRefusal(state: DaemonState): string | null {
  switch (state) {
    case "inactive":
      return null;
    case "active":
      return (
        "a CBM daemon is active, and `install` drains active CBM sessions before configuring, so running the " +
        `harvest now would stop every CBM session on this machine. Close them, or pass ${OVERRIDE_FLAG} to accept it.`
      );
    case "unknown":
      return (
        "the CBM daemon status could not be determined, which is treated as active: `install` drains active CBM " +
        `sessions before configuring. Pass ${OVERRIDE_FLAG} to proceed anyway.`
      );
  }
}

/** The emitted content each shipped artifact is derived from. */
export interface EmittedSources {
  /** The emitted skill file, frontmatter included. */
  readonly skill: string;
  /** The emitted instructions file, which carries no frontmatter. */
  readonly rule: string;
  /** Each emitted parent-handoff agent, in {@link AGENT_SOURCES} order. */
  readonly agents: readonly string[];
  /** What `install` printed, for the provenance record and for a failure report. */
  readonly transcript: string;
}

export interface CollectOptions {
  /** Proceed even though a daemon is active or its state is unknown. */
  readonly stopSessions?: boolean;
}

/**
 * Runs `install` against a temporary `HOME` and returns what it emitted.
 *
 * The temporary directory never escapes this function: the caller receives the
 * emitted *content*, so there is no window in which a later failure could leave
 * a scratch machine's configuration on disk.
 *
 * `--clients` is always explicit. Omitting it configures every client detected
 * on the host running the harvest, which on a contributor's machine is their
 * real editors.
 */
export async function collect(executable: string, options: CollectOptions = {}): Promise<EmittedSources> {
  const state = await daemonState(executable);
  const refusal = daemonRefusal(state);
  if (refusal !== null && options.stopSessions !== true) throw new HarvestError(refusal);

  const home = await mkdtemp(path.join(tmpdir(), "cbm-harvest-"));
  try {
    for (const directory of DETECTION_DIRS) {
      await mkdir(path.join(home, directory), { recursive: true });
    }

    const install = await run(
      [
        executable,
        "install",
        "-y",
        "--force",
        "--skip-binary",
        `--clients=${SOURCE_CLIENTS.join(",")}`,
      ],
      {
        timeoutMs: 180_000,
        // `HOME` redirects every file `install` writes. `CBM_CACHE_DIR` keeps it
        // out of the operator's canonical cache, which is the one holding the
        // graph their sessions use.
        //
        // Observed rather than assumed, on a machine whose daemon held a
        // different cache root: `install` is *not* refused for the mismatch, and
        // an ordinary `cli` command in the same situation is -- outright, with
        // `CBM could not start because the active account daemon uses a
        // different cache directory`. A real run went through, and the daemon
        // came back under a new pid, which is the drain this guard exists to
        // make deliberate. So the isolation rests on the daemon guard above and
        // on `HOME`, never on CBM declining. The indexed projects survived it:
        // the graph is in the cache, not in the process.
        env: { HOME: home, CBM_CACHE_DIR: path.join(home, "cache") },
      },
    );

    const transcript = `${install.stdout}${install.stderr}`.trim();
    if (!install.ok) {
      throw new HarvestError(
        `\`install\` failed with exit ${install.exitCode}` +
          `${install.spawnError === undefined ? "" : ` (${install.spawnError})`}: ${transcript}`,
      );
    }

    const [skill, rule] = await Promise.all([readEmitted(home, SKILL_SOURCE), readEmitted(home, RULE_SOURCE)]);

    const present = (await readdir(path.join(home, AGENTS_SOURCE_DIR))).filter((name) => name.endsWith(".md")).sort();
    const unexpected = present.filter((name) => !AGENT_SOURCES.includes(name as (typeof AGENT_SOURCES)[number]));
    if (unexpected.length > 0) {
      throw new HarvestError(
        `${AGENTS_SOURCE_DIR} holds agent file(s) this pipeline does not know about: ${unexpected.join(", ")}; ` +
          "CBM has added a tier and the shipped set must be revisited rather than silently missing it",
      );
    }

    const agents = await Promise.all(
      AGENT_SOURCES.map(async (name) => await readEmitted(home, `${AGENTS_SOURCE_DIR}/${name}`)),
    );

    return { skill, rule, agents, transcript };
  } finally {
    // Including on failure: a refusal above must not be the reason a scratch
    // machine's configuration outlives the process that made it.
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * Reads one emitted file, failing with the path when it is not there.
 *
 * Only the skill, the instruction file, and the agents are read. The hook
 * scripts, settings files, and MCP configuration `install` emits beside them are
 * for clients this package is not; nothing here reads or ships them.
 */
async function readEmitted(home: string, relative: string): Promise<string> {
  const file = Bun.file(path.join(home, relative));
  if (!(await file.exists())) {
    throw new HarvestError(
      `\`install\` did not emit ${relative}; the emitted paths are not a public contract and this one has moved`,
    );
  }
  return await file.text();
}
