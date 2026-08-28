import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";

import { upsertEntry } from "../../src/mcp-config.ts";
import { agentDir, mcpConfigPath, packageRoot } from "../../src/paths.ts";
import { dropScratch, makeScratch, type Scratch } from "../support/scratch.ts";

const COMMAND = "/scratch/.omp/codebase-memory/bin/0.10.8/codebase-memory-mcp";

interface AgentDirCase {
  readonly scenario: string;
  /** The environment beyond `HOME` and `PATH`. */
  readonly env: Readonly<Record<string, string>>;
  /** The agent directory, relative to the scratch home. `null` means absolute. */
  readonly relative: string | null;
  /** Used only when {@link AgentDirCase.relative} is `null`. */
  readonly absolute?: string;
}

/**
 * OMP's own precedence, reproduced.
 *
 * `PI_CODING_AGENT_DIR` first is not a guess: OMP's CLI calls `setProfile(...)`
 * on every start, and a named profile makes that call write the variable back
 * as the profile's own agent directory. Inside a session the variable is
 * therefore already OMP's answer. The profile branch is the fallback for a
 * process that never went through that CLI.
 */
const agentDirs: AgentDirCase[] = [
  {
    scenario: "no profile and no override resolves the default agent directory",
    env: {},
    relative: ".omp/agent",
  },
  {
    scenario: "OMP_PROFILE resolves that profile's agent directory",
    env: { OMP_PROFILE: "work" },
    relative: ".omp/profiles/work/agent",
  },
  {
    scenario: "PI_PROFILE is honoured as the legacy fallback",
    env: { PI_PROFILE: "legacy" },
    relative: ".omp/profiles/legacy/agent",
  },
  {
    // OMP resolves the canonical variable first and consults the legacy one only
    // when the canonical one is undefined.
    scenario: "OMP_PROFILE wins over PI_PROFILE",
    env: { OMP_PROFILE: "work", PI_PROFILE: "legacy" },
    relative: ".omp/profiles/work/agent",
  },
  {
    // An explicitly empty OMP_PROFILE selects the default profile rather than
    // silently inheriting the legacy variable, which is OMP's own rule.
    scenario: "an empty OMP_PROFILE selects the default profile, not PI_PROFILE",
    env: { OMP_PROFILE: "", PI_PROFILE: "legacy" },
    relative: ".omp/agent",
  },
  {
    scenario: "PI_CODING_AGENT_DIR takes precedence over a profile variable",
    env: { PI_CODING_AGENT_DIR: "/tmp/cbm-explicit-agent", OMP_PROFILE: "work" },
    relative: null,
    absolute: "/tmp/cbm-explicit-agent",
  },
  {
    scenario: "PI_CONFIG_DIR renames the config directory every path hangs off",
    env: { PI_CONFIG_DIR: ".omp-alt" },
    relative: ".omp-alt/agent",
  },
];

test("every case names itself distinctly", () => {
  const scenarios = agentDirs.map((entry) => entry.scenario);
  expect(new Set(scenarios).size).toBe(scenarios.length);
});

describe("agent directory resolution", () => {
  test.each(agentDirs)("$scenario", async ({ env, relative, absolute }) => {
    const scratch = await makeScratch({ env });
    try {
      expect(agentDir(scratch.host)).toBe(
        relative === null ? (absolute ?? "") : path.join(scratch.home, relative),
      );
    } finally {
      await dropScratch(scratch);
    }
  });
});

describe("the package-owned root follows the config directory", () => {
  test("the default config directory puts it under ~/.omp", async () => {
    const scratch = await makeScratch();
    try {
      expect(packageRoot(scratch.host)).toBe(path.join(scratch.home, ".omp", "codebase-memory"));
    } finally {
      await dropScratch(scratch);
    }
  });

  test("a profile does not move it, so a managed copy survives a profile switch", async () => {
    const plain = await makeScratch();
    const profiled = await makeScratch({ env: { OMP_PROFILE: "work" } });
    try {
      expect(path.relative(plain.home, packageRoot(plain.host))).toBe(
        path.relative(profiled.home, packageRoot(profiled.host)),
      );
    } finally {
      await dropScratch(plain);
      await dropScratch(profiled);
    }
  });
});

describe("the write target follows the agent directory", () => {
  let scratch: Scratch;

  beforeEach(async () => {
    scratch = await makeScratch({ env: { OMP_PROFILE: "work" } });
  });

  afterEach(async () => {
    await dropScratch(scratch);
  });

  test("an active profile is written to, and the default agent directory is not", async () => {
    const outcome = await upsertEntry(scratch.host, COMMAND, undefined);
    expect(outcome.ok && outcome.change).toBe("created");

    const profileFile = path.join(scratch.home, ".omp/profiles/work/agent/mcp.json");
    const defaultFile = path.join(scratch.home, ".omp/agent/mcp.json");

    expect(mcpConfigPath(scratch.host)).toBe(profileFile);
    expect(await Bun.file(profileFile).exists()).toBe(true);
    expect(await Bun.file(defaultFile).exists()).toBe(false);
  });

  test("an explicit agent directory is written to instead of the profile's", async () => {
    const explicit = path.join(scratch.root, "explicit-agent");
    const host = { ...scratch.host, env: { ...scratch.host.env, PI_CODING_AGENT_DIR: explicit } };

    const outcome = await upsertEntry(host, COMMAND, undefined);
    expect(outcome.ok && outcome.change).toBe("created");

    expect(await Bun.file(path.join(explicit, "mcp.json")).exists()).toBe(true);
    expect(
      await Bun.file(path.join(scratch.home, ".omp/profiles/work/agent/mcp.json")).exists(),
    ).toBe(false);
  });
});
