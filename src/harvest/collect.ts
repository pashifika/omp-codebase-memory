import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { run } from "../exec.ts";

import { classifyDaemonStatus, type DaemonState } from "./guards.ts";
import { HarvestError } from "./transform.ts";

/**
 * Driving CBM's own `install` to emit the content this package ships.
 *
 * `install` is CBM's activation path, not a harmless read: it drains active CBM
 * sessions before configuring, and it writes agent configuration into `HOME`. So
 * everything here is about containment -- a temporary `HOME`, an isolated cache
 * root, and an explicit client list.
 *
 * The daemon refusal is not here. It has to be decided before the `--clients`
 * vocabulary probe, which is itself an `install` invocation, so it is decided
 * once by the pipeline entry point and this module is only ever reached after
 * it passed. See {@link collect}.
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

/**
 * What `daemon status` reports.
 *
 * The reading of the output is {@link classifyDaemonStatus}, which is pure and
 * therefore testable; this is only the part that needs the executable.
 */
export async function daemonState(executable: string): Promise<DaemonState> {
  const status = await run([executable, "daemon", "status"], { timeoutMs: 30_000 });
  if (!status.ok || status.spawnError !== undefined) return "unknown";
  return classifyDaemonStatus(`${status.stdout}${status.stderr}`);
}

/** The emitted content each shipped artifact is derived from. */
export interface EmittedSources {
  /** The emitted skill file, frontmatter included. */
  readonly skill: string;
  /** The emitted instructions file, which carries no frontmatter. */
  readonly rule: string;
  /** Each emitted parent-handoff agent, in {@link AGENT_SOURCES} order. */
  readonly agents: readonly string[];
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
 *
 * The daemon refusal is the caller's, and this function does not re-query it.
 * `install` drains active CBM sessions, so the decision has to be made before
 * the first invocation of it -- which is the `--clients` vocabulary probe in
 * `vocabulary.ts`, not this one. A second query here would also be a second
 * observation, and it could disagree with the state the operator was told about
 * and consented to. `scripts/harvest.ts` decides it once, for both.
 */
export async function collect(executable: string): Promise<EmittedSources> {
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
        // came back under a new pid, which is the drain the pipeline's daemon
        // guard exists to make deliberate. So the isolation rests on that guard
        // -- decided once in `scripts/harvest.ts`, before the first invocation
        // of `install` -- and on `HOME`, never on CBM declining. The indexed
        // projects survived it: the graph is in the cache, not in the process.
        env: { HOME: home, CBM_CACHE_DIR: path.join(home, "cache") },
      },
    );

    if (!install.ok) {
      const transcript = `${install.stdout}${install.stderr}`.trim();
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

    return { skill, rule, agents };
  } finally {
    // Including on failure: a failed run must not be the reason a scratch
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
