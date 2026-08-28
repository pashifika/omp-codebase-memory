import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { entryStatus, MCP_SCHEMA_URL, removeEntry, upsertEntry } from "../../src/mcp-config.ts";
import { managedBinRoot, managedExecutable, mcpConfigPath } from "../../src/paths.ts";
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
 * A file holding nothing but the `$schema` this package writes and the owned
 * entry -- which is exactly what a file this package created looks like.
 */
const OURS_ONLY = `{
  "$schema": "${MCP_SCHEMA_URL}",
  "mcpServers": {
    "codebase-memory-mcp": {
      "type": "stdio",
      "command": "${OURS}",
      "args": []
    }
  }
}
`;

/** The owned entry beside a `disabledServers` list the operator added. */
const OURS_WITH_DENYLIST = `{
  "$schema": "${MCP_SCHEMA_URL}",
  "mcpServers": {
    "codebase-memory-mcp": {
      "command": "${OURS}"
    }
  },
  "disabledServers": []
}
`;

/** The owned entry in a file whose `$schema` this package did not write. */
const OURS_WITH_FOREIGN_SCHEMA = `{
  "$schema": "./mcp-schema.json",
  "mcpServers": {
    "codebase-memory-mcp": {
      "command": "${OURS}"
    }
  }
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

/**
 * A file whose owned entry names `command`, written by hand rather than through
 * this package.
 *
 * Needed wherever the `command` is only known once a scratch host exists -- a
 * path under that host's own managed bin root -- which a module-level literal
 * cannot spell.
 */
function entryNaming(command: string): string {
  return `{
  "mcpServers": {
    "codebase-memory-mcp": {
      "type": "stdio",
      "command": "${command}",
      "args": []
    }
  }
}
`;
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
  {
    // The one malformed shape the reader used to recognise by discarding: an
    // `mcpServers` value that is not a map was replaced wholesale, taking the
    // operator's content with it.
    scenario: "an mcpServers value that is not an object is refused rather than replaced",
    before: `{
  "mcpServers": [
    { "name": "keeper", "command": "/bin/true" }
  ],
  "other": 1
}
`,
    previouslyWrote: OURS,
    reported: /mcpServers value that is not a JSON object/u,
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

interface RemovalFateCase {
  readonly scenario: string;
  readonly before: string;
  /** Whether the file itself is still there once the owned key is gone. */
  readonly fileRemains: boolean;
}

/**
 * What removal does with the file, not just with the key.
 *
 * Rolling back is supposed to return the machine to its pre-install state, so a
 * file this package created has to go with its last key -- while anything the
 * operator had, including a `$schema` value this package did not write, is
 * content it never owned and must survive.
 */
const removalFates: RemovalFateCase[] = [
  {
    scenario: "a file holding only this package's schema and entry is removed with the key",
    before: OURS_ONLY,
    fileRemains: false,
  },
  {
    scenario: "a file holding a disabledServers list the operator added is kept",
    before: OURS_WITH_DENYLIST,
    fileRemains: true,
  },
  {
    scenario: "a file whose schema this package did not write is kept",
    before: OURS_WITH_FOREIGN_SCHEMA,
    fileRemains: true,
  },
];

interface UnreadableCase {
  readonly scenario: string;
  /** Puts something at `file` that exists and cannot be read. */
  readonly place: (file: string) => Promise<void>;
  /** The errno the report must name. */
  readonly errno: RegExp;
}

/**
 * A file that is present but unreadable is not an absent entry.
 *
 * Reachable without a hand edit: root-owned after a `sudo omp`, or mode 0600
 * under another uid. Reporting it as "absent" tells the operator the entry is
 * missing from a file this package could not open, where the entry may well be.
 */
const unreadables: UnreadableCase[] = [
  {
    scenario: "a file the process may not open is reported with its errno",
    place: async (file) => {
      await Bun.write(file, OURS_ONLY);
      await chmod(file, 0o000);
    },
    errno: /EACCES/u,
  },
  {
    scenario: "a directory where the file belongs is reported with its errno",
    place: async (file) => {
      await mkdir(file, { recursive: true });
    },
    errno: /EISDIR/u,
  },
];

test("every case names itself distinctly", () => {
  const scenarios = [
    ...writes,
    ...writeRefusals,
    ...removals,
    ...removalRefusals,
    ...removalFates,
    ...unreadables,
  ].map((entry) => entry.scenario);
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

  /**
   * A lost `state.json` -- `readState` falls back to an empty state on a
   * truncated file, and uninstall deletes the same file -- leaves no recorded
   * write, and then only the path can decide ownership. Nothing but this
   * package ever writes under its own managed bin root.
   */
  test("an entry under this package's own bin root is ours with nothing recorded", async () => {
    const older = managedExecutable(scratch.host, "0.10.8");
    const newer = managedExecutable(scratch.host, "0.10.9");
    await arrange(entryNaming(older));

    const outcome = await upsertEntry(scratch.host, newer, undefined);
    expect(outcome.ok && outcome.change).toBe("updated");

    const written = JSON.parse(await Bun.file(mcpConfigPath(scratch.host)).text()) as {
      mcpServers: Record<string, { command?: string }>;
    };
    expect(written.mcpServers["codebase-memory-mcp"]?.command).toBe(newer);
  });

  test("a directory whose name merely shares the bin root's prefix is still foreign", async () => {
    const lookalike = path.join(`${managedBinRoot(scratch.host)}-backup`, "0.10.8", "cbm");
    await arrange(entryNaming(lookalike));

    const resolved = managedExecutable(scratch.host, "0.10.9");
    const outcome = await upsertEntry(scratch.host, resolved, undefined);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain(lookalike);
  });

  test("a compact file whose entry already names the resolved path is not rewritten", async () => {
    const compact = `{"$schema":"s","mcpServers":{"codebase-memory-mcp":{"type":"stdio","command":"${OURS}","args":[]}}}`;
    await arrange(compact);

    const outcome = await upsertEntry(scratch.host, OURS, OURS);
    expect(outcome.ok && outcome.change).toBe("unchanged");
    expect(await Bun.file(mcpConfigPath(scratch.host)).text()).toBe(compact);
  });

  test("a rewrite replaces the file rather than truncating it in place", async () => {
    await arrange("owned");
    const file = mcpConfigPath(scratch.host);
    const before = await stat(file);

    await upsertEntry(scratch.host, MOVED, OURS);

    // A durable write stages a temp file beside the target and renames it into
    // place, so the visible file is a new inode. An in-place truncate keeps the
    // inode, and the window it opens is one in which OMP reads a half-written
    // document and silently loads zero user-level MCP servers.
    expect((await stat(file)).ino).not.toBe(before.ino);
  });

  /**
   * `rename` replaces the destination rather than truncating it, so the visible
   * file takes the staging file's mode unless it is set first. This file can
   * carry per-server `env` secrets, remote `headers` and an
   * `auth.clientSecret`, and OMP's own writer creates it 0600 -- so any
   * `mcp.json` last written by `/mcp add|enable|disable` is 0600 on disk, and a
   * session-start correction that published it 0644 would be a disclosure.
   */
  test("a rewrite preserves the destination's own mode", async () => {
    await arrange("owned");
    const file = mcpConfigPath(scratch.host);
    await chmod(file, 0o600);

    await upsertEntry(scratch.host, MOVED, OURS);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test("a mode the operator widened is reproduced rather than narrowed", async () => {
    await arrange("owned");
    const file = mcpConfigPath(scratch.host);
    await chmod(file, 0o644);

    await upsertEntry(scratch.host, MOVED, OURS);
    expect((await stat(file)).mode & 0o777).toBe(0o644);
  });

  test("a created file is not world-readable", async () => {
    await upsertEntry(scratch.host, OURS, undefined);
    expect((await stat(mcpConfigPath(scratch.host))).mode & 0o777).toBe(0o600);
  });

  test("a write leaves no staging file behind", async () => {
    await arrange("owned");
    await upsertEntry(scratch.host, MOVED, OURS);
    expect(await readdir(path.dirname(mcpConfigPath(scratch.host)))).toEqual(["mcp.json"]);
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

  test.each(removalFates)("$scenario", async ({ before, fileRemains }) => {
    await arrange(before);

    const outcome = await removeEntry(scratch.host, OURS);
    expect(outcome.ok && outcome.change).toBe("removed");
    expect(await Bun.file(mcpConfigPath(scratch.host)).exists()).toBe(fileRemains);
  });

  test("removal takes back an entry under this package's bin root with nothing recorded", async () => {
    await arrange(entryNaming(managedExecutable(scratch.host, "0.10.8")));

    const outcome = await removeEntry(scratch.host, undefined);
    expect(outcome.ok && outcome.change).toBe("removed");
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

  test.each(unreadables)("$scenario", async ({ place, errno }) => {
    const file = mcpConfigPath(scratch.host);
    await mkdir(path.dirname(file), { recursive: true });
    await place(file);

    const reported = await entryStatus(scratch.host, OURS);
    expect(reported.problem).toMatch(errno);
    expect(reported.problem).toContain(file);

    // And no write is attempted against a file whose content is unknown.
    expect((await upsertEntry(scratch.host, OURS, OURS)).ok).toBe(false);
  });
});
