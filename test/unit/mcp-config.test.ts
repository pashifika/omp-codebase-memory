import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { entryStatus, MCP_SCHEMA_URL, removeEntry, upsertEntry } from "../../src/mcp-config.ts";
import { mcpConfigPath } from "../../src/paths.ts";
import { dropScratch, makeScratch, type Scratch } from "../support/scratch.ts";

const OURS = "/home/scratch/.omp/codebase-memory/bin/0.10.8/codebase-memory-mcp";
const MOVED = "/home/scratch/.omp/codebase-memory/bin/0.10.9/codebase-memory-mcp";

/**
 * The two unrelated servers and the denylist, spelled the way OMP's own writer
 * spells them: two-space indentation, trailing newline.
 *
 * Held as separate constants so a test can assert each one appears verbatim
 * after a write, which is the property the whole "one owned key" constraint
 * exists to deliver.
 */
const FILESYSTEM_BLOCK = `    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/srv"
      ]
    }`;

const GITHUB_BLOCK = `    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    }`;

const DISABLED_BLOCK = `  "disabledServers": [
    "github"
  ]`;

const NEIGHBOURS = `{
  "$schema": "${MCP_SCHEMA_URL}",
  "mcpServers": {
${FILESYSTEM_BLOCK},
${GITHUB_BLOCK}
  },
${DISABLED_BLOCK}
}
`;

/**
 * How the file looks before the operation under test.
 *
 * `"none"` is no file at all. `"owned"` is an entry written through this
 * package, which is the only way an entry it can decidably take back comes to
 * exist. Anything else is literal file contents.
 */
type Before = "none" | "owned" | (string & {});

let scratch: Scratch;

beforeEach(async () => {
  scratch = await makeScratch();
});

afterEach(async () => {
  await dropScratch(scratch);
});

/** Puts the scratch agent directory into the state `before` describes. */
async function arrange(before: Before): Promise<void> {
  if (before === "none") return;
  if (before === "owned") {
    await upsertEntry(scratch.host, OURS, undefined);
    return;
  }
  const file = mcpConfigPath(scratch.host);
  await mkdir(path.dirname(file), { recursive: true });
  await Bun.write(file, before);
}

interface WriteCase {
  readonly scenario: string;
  readonly before: Before;
  /** The `command` this package's state says it last wrote. */
  readonly previouslyWrote: string | undefined;
  readonly command: string;
  readonly change: "created" | "updated" | "unchanged";
}

const writes: WriteCase[] = [
  {
    scenario: "creating the file writes the single owned entry",
    before: "none",
    previouslyWrote: undefined,
    command: OURS,
    change: "created",
  },
  {
    scenario: "adding to a file with unrelated servers reports an update",
    before: NEIGHBOURS,
    previouslyWrote: undefined,
    command: OURS,
    change: "updated",
  },
  {
    scenario: "an entry that already names the resolved path is left as it is",
    before: "owned",
    previouslyWrote: OURS,
    command: OURS,
    change: "unchanged",
  },
  {
    scenario: "a moved executable updates the command",
    before: "owned",
    previouslyWrote: OURS,
    command: MOVED,
    change: "updated",
  },
  {
    // An entry naming the currently resolved path is ours to adopt even with
    // nothing recorded, which is how a lost state file recovers.
    scenario: "an entry naming the resolved path is adopted with no recorded write",
    before: "owned",
    previouslyWrote: undefined,
    command: OURS,
    change: "unchanged",
  },
];

interface WriteRefusalCase {
  readonly scenario: string;
  readonly before: string;
  readonly previouslyWrote: string | undefined;
  /** The text the refusal must name. */
  readonly reported: RegExp;
}

const writeRefusals: WriteRefusalCase[] = [
  {
    scenario: "an entry this package did not write is refused with both paths named",
    before: `{
  "mcpServers": {
    "codebase-memory-mcp": {
      "command": "/opt/homebrew/bin/codebase-memory-mcp"
    }
  }
}
`,
    previouslyWrote: undefined,
    reported:
      /already defines codebase-memory-mcp with command \/opt\/homebrew\/bin\/codebase-memory-mcp/u,
  },
  {
    scenario: "an unparseable file is refused as a structural problem naming the path",
    before: '{ "mcpServers": { "codebase-memory-mcp": ',
    previouslyWrote: OURS,
    reported: /mcp\.json is not parseable JSON, so it was left untouched/u,
  },
  {
    scenario: "a document that is not a JSON object is refused",
    before: "[]\n",
    previouslyWrote: OURS,
    reported: /does not hold a JSON object/u,
  },
];

interface RemovalCase {
  readonly scenario: string;
  readonly before: Before;
  readonly wroteCommand: string | undefined;
  readonly change: "removed" | "absent";
}

const removals: RemovalCase[] = [
  {
    scenario: "removal deletes the owned key",
    before: "owned",
    wroteCommand: OURS,
    change: "removed",
  },
  {
    scenario: "removal succeeds when there is no file at all",
    before: "none",
    wroteCommand: OURS,
    change: "absent",
  },
  {
    scenario: "removal succeeds when the file holds no owned key",
    before: NEIGHBOURS,
    wroteCommand: OURS,
    change: "absent",
  },
];

interface RemovalRefusalCase {
  readonly scenario: string;
  readonly wroteCommand: string | undefined;
  readonly reported: RegExp;
}

const removalRefusals: RemovalRefusalCase[] = [
  {
    scenario: "removal refuses an entry whose command someone else changed",
    wroteCommand: MOVED,
    reported: /is not what this package wrote/u,
  },
  {
    scenario: "removal refuses when nothing was ever recorded as written",
    wroteCommand: undefined,
    reported: /nothing recorded/u,
  },
];

test("every case names itself distinctly", () => {
  const scenarios = [...writes, ...writeRefusals, ...removals, ...removalRefusals].map(
    (entry) => entry.scenario,
  );
  expect(new Set(scenarios).size).toBe(scenarios.length);
});

describe("upsert", () => {
  test.each(writes)("$scenario", async ({ before, previouslyWrote, command, change }) => {
    await arrange(before);

    const outcome = await upsertEntry(scratch.host, command, previouslyWrote);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.change).toBe(change);

    const written = JSON.parse(await Bun.file(mcpConfigPath(scratch.host)).text()) as {
      mcpServers: Record<string, unknown>;
    };
    expect(written.mcpServers["codebase-memory-mcp"]).toEqual({
      type: "stdio",
      command,
      args: [],
    });
  });

  test.each(writeRefusals)("$scenario", async ({ before, previouslyWrote, reported }) => {
    await arrange(before);
    const outcome = await upsertEntry(scratch.host, OURS, previouslyWrote);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toMatch(reported);
    expect(await Bun.file(mcpConfigPath(scratch.host)).text()).toBe(before);
  });

  test("a created file carries the schema OMP writes for its own managed files", async () => {
    await upsertEntry(scratch.host, OURS, undefined);
    const written = JSON.parse(await Bun.file(mcpConfigPath(scratch.host)).text()) as {
      $schema?: string;
    };
    expect(written.$schema).toBe(MCP_SCHEMA_URL);
  });

  test("unrelated servers and disabledServers survive a write byte for byte", async () => {
    await arrange(NEIGHBOURS);
    await upsertEntry(scratch.host, OURS, undefined);

    const after = await Bun.file(mcpConfigPath(scratch.host)).text();
    expect(after).toContain(FILESYSTEM_BLOCK);
    expect(after).toContain(GITHUB_BLOCK);
    expect(after).toContain(DISABLED_BLOCK);
    expect(after.endsWith("\n")).toBe(true);
  });

  test("a no-op re-run leaves the file byte-identical", async () => {
    await arrange("owned");
    const file = mcpConfigPath(scratch.host);
    const first = await Bun.file(file).text();

    await upsertEntry(scratch.host, OURS, OURS);
    expect(await Bun.file(file).text()).toBe(first);
  });

  test("a path change rewrites the command and nothing else", async () => {
    await arrange(NEIGHBOURS);
    await upsertEntry(scratch.host, OURS, undefined);
    const before = await Bun.file(mcpConfigPath(scratch.host)).text();

    await upsertEntry(scratch.host, MOVED, OURS);
    expect(await Bun.file(mcpConfigPath(scratch.host)).text()).toBe(before.replace(OURS, MOVED));
  });

  test("a four-space file keeps its own indentation", async () => {
    await arrange('{\n    "mcpServers": {}\n}\n');
    await upsertEntry(scratch.host, OURS, undefined);
    expect(await Bun.file(mcpConfigPath(scratch.host)).text()).toContain('\n    "mcpServers"');
  });

  test("fields the operator added to the owned entry are preserved", async () => {
    await arrange(
      `{\n  "mcpServers": {\n    "codebase-memory-mcp": {\n      "command": "${OURS}",\n      "timeout": 120000\n    }\n  }\n}\n`,
    );
    await upsertEntry(scratch.host, MOVED, OURS);

    const written = JSON.parse(await Bun.file(mcpConfigPath(scratch.host)).text()) as {
      mcpServers: Record<string, { timeout?: number; command?: string }>;
    };
    expect(written.mcpServers["codebase-memory-mcp"]?.timeout).toBe(120000);
    expect(written.mcpServers["codebase-memory-mcp"]?.command).toBe(MOVED);
  });
});

describe("removal", () => {
  test.each(removals)("$scenario", async ({ before, wroteCommand, change }) => {
    await arrange(before);

    const outcome = await removeEntry(scratch.host, wroteCommand);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.change).toBe(change);
  });

  test.each(removalRefusals)("$scenario", async ({ wroteCommand, reported }) => {
    await arrange("owned");
    const before = await Bun.file(mcpConfigPath(scratch.host)).text();

    const outcome = await removeEntry(scratch.host, wroteCommand);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toMatch(reported);
    expect(await Bun.file(mcpConfigPath(scratch.host)).text()).toBe(before);
  });

  test("every other key is byte-identical after the owned key is removed", async () => {
    await arrange(NEIGHBOURS);
    await upsertEntry(scratch.host, OURS, undefined);
    await removeEntry(scratch.host, OURS);

    expect(await Bun.file(mcpConfigPath(scratch.host)).text()).toBe(NEIGHBOURS);
  });

  test("the file stays in place when other servers remain", async () => {
    await arrange(NEIGHBOURS);
    await upsertEntry(scratch.host, OURS, undefined);
    await removeEntry(scratch.host, OURS);

    expect(await Bun.file(mcpConfigPath(scratch.host)).exists()).toBe(true);
  });
});

describe("status", () => {
  test("reports an absent entry without creating one", async () => {
    const reported = await entryStatus(scratch.host, OURS);
    expect(reported.present).toBe(false);
    expect(reported.current).toBe(false);
    expect(await Bun.file(mcpConfigPath(scratch.host)).exists()).toBe(false);
  });

  test("reports a stale entry as present but not current", async () => {
    await arrange("owned");
    const reported = await entryStatus(scratch.host, MOVED);
    expect(reported.present).toBe(true);
    expect(reported.command).toBe(OURS);
    expect(reported.current).toBe(false);
  });

  test("reports an unreadable file as a problem rather than an absent entry", async () => {
    await arrange("{ oops");
    expect((await entryStatus(scratch.host, OURS)).problem).toMatch(/not parseable JSON/u);
  });
});
