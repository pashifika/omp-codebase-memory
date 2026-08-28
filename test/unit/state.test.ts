import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { statePath } from "../../src/paths.ts";
import { readState, updateState, writeState, type State } from "../../src/state.ts";
import { dropScratch, makeScratch, type Scratch } from "../support/scratch.ts";

/**
 * What `readState` must return for a document it did not write.
 *
 * The filtering this table pins is the only thing between a corrupted
 * `state.json` and code that joins a recorded value straight into a path
 * (`managedExecutable(host, state.managedVersion)`) or does arithmetic on it
 * (the 24-hour check interval). The file is this package's own cache, so the
 * recoverable reading of every malformed value is "forget what was cached"
 * rather than a refusal that would fail a session start.
 */
interface SanitizationCase {
  readonly scenario: string;
  /** The file's raw bytes, written verbatim. */
  readonly document: string;
  /** Everything the read must return, and nothing else. */
  readonly state: State;
}

const sanitizations: SanitizationCase[] = [
  {
    scenario: "a truncated document reads as empty rather than throwing",
    document: '{"managedVersion":"0.10.8","pi',
    state: {},
  },
  {
    scenario: "a JSON array reads as empty",
    document: "[]\n",
    state: {},
  },
  {
    scenario: "a JSON string reads as empty",
    document: '"0.10.8"\n',
    state: {},
  },
  {
    scenario: "a JSON null reads as empty",
    document: "null\n",
    state: {},
  },
  {
    scenario: "a numeric pin is dropped so no non-string reaches a path segment",
    document: '{"managedVersion":"0.10.8","pin":10.8}',
    state: { managedVersion: "0.10.8" },
  },
  {
    scenario: "an object managedVersion is dropped rather than joined into a path",
    document: '{"managedVersion":{"toString":"0.10.8"},"pin":"0.10.8"}',
    state: { pin: "0.10.8" },
  },
  {
    scenario: "an empty-string managedVersion is dropped so the pointer never names bin/",
    document: '{"managedVersion":"","pin":"0.10.8"}',
    state: { pin: "0.10.8" },
  },
  {
    // `1e999` is valid JSON and parses to `Infinity`, which is how a non-finite
    // number reaches the rate-limit arithmetic without a hand-written literal.
    scenario: "a non-finite lastCheckedAt is dropped so the check interval never reads Infinity",
    document: '{"managedVersion":"0.10.8","lastCheckedAt":1e999}',
    state: { managedVersion: "0.10.8" },
  },
  {
    scenario: "a string lastCheckedAt is dropped rather than subtracted from a timestamp",
    document: '{"managedVersion":"0.10.8","lastCheckedAt":"1700000000000"}',
    state: { managedVersion: "0.10.8" },
  },
  {
    scenario: "keys this package does not recognise are not carried through",
    document: '{"managedVersion":"0.10.8","source":"github","nested":{"pin":"0.9.0"}}',
    state: { managedVersion: "0.10.8" },
  },
  {
    scenario: "a fully valid document survives field for field",
    document: `{
  "managedVersion": "0.10.8",
  "managedDigest": "e2804a20",
  "pin": "0.10.8",
  "upstreamVersion": "0.11.0",
  "lastCheckedAt": 1700000000000,
  "wroteCommand": "/home/scratch/.omp/codebase-memory/bin/0.10.8/codebase-memory-mcp"
}
`,
    state: {
      managedVersion: "0.10.8",
      managedDigest: "e2804a20",
      pin: "0.10.8",
      upstreamVersion: "0.11.0",
      lastCheckedAt: 1700000000000,
      wroteCommand: "/home/scratch/.omp/codebase-memory/bin/0.10.8/codebase-memory-mcp",
    },
  },
];

let scratch: Scratch;

beforeEach(async () => {
  scratch = await makeScratch();
});

afterEach(async () => {
  await dropScratch(scratch);
});

test("every case names itself distinctly", () => {
  const scenarios = sanitizations.map((entry) => entry.scenario);
  expect(new Set(scenarios).size).toBe(scenarios.length);
});

describe("a recorded state is sanitized on the way in", () => {
  test.each(sanitizations)("$scenario", async ({ document, state }) => {
    const file = statePath(scratch.host);
    await mkdir(path.dirname(file), { recursive: true });
    await Bun.write(file, document);

    expect(await readState(scratch.host)).toEqual(state);
  });

  test("a missing file is the first-run case, not a failure", async () => {
    expect(await readState(scratch.host)).toEqual({});
  });
});

describe("the state is written durably", () => {
  test("a rewrite replaces the file rather than truncating it in place", async () => {
    await writeState(scratch.host, { managedVersion: "0.10.8" });
    const before = await stat(statePath(scratch.host));

    await writeState(scratch.host, { managedVersion: "0.11.0" });

    // A durable write stages the document beside the target and renames it in,
    // so the visible file is a new inode. An in-place truncate keeps the inode,
    // and an interrupted one leaves a document that no longer parses -- which
    // this reader degrades to the empty state, forgetting the operator's pin and
    // the receipt that decides whether the MCP entry is ours to take back.
    expect((await stat(statePath(scratch.host))).ino).not.toBe(before.ino);
  });

  /**
   * `rename` replaces the destination rather than truncating it, so the visible
   * file takes the staging file's mode unless it is set first. Nothing here is
   * a secret today, but a package-private cache is not the operator's to have
   * widened by a write they did not ask for.
   */
  test("a rewrite preserves the destination's own mode", async () => {
    await writeState(scratch.host, { managedVersion: "0.10.8" });
    await chmod(statePath(scratch.host), 0o600);

    await writeState(scratch.host, { managedVersion: "0.11.0" });
    expect((await stat(statePath(scratch.host))).mode & 0o777).toBe(0o600);
  });

  /**
   * The row that distinguishes reproducing the destination's mode from
   * hardcoding a narrow one: 0600 arranged and 0600 asserted are the same
   * assertion a `chmod(staging, 0o600)` would satisfy, so without a widened
   * case this file cannot tell the two apart.
   */
  test("a mode the operator widened is reproduced rather than narrowed", async () => {
    await writeState(scratch.host, { managedVersion: "0.10.8" });
    await chmod(statePath(scratch.host), 0o644);

    await writeState(scratch.host, { managedVersion: "0.11.0" });
    expect((await stat(statePath(scratch.host))).mode & 0o777).toBe(0o644);
  });

  test("a created state file is not world-readable", async () => {
    await writeState(scratch.host, { managedVersion: "0.10.8" });
    expect((await stat(statePath(scratch.host))).mode & 0o777).toBe(0o600);
  });

  test("a write leaves no staging file behind", async () => {
    await writeState(scratch.host, { managedVersion: "0.10.8" });
    expect(await readdir(path.dirname(statePath(scratch.host)))).toEqual(["state.json"]);
  });

  test("a merge keeps the fields it was not given and replaces the ones it was", async () => {
    await writeState(scratch.host, { managedVersion: "0.10.8", pin: "0.10.8" });

    expect(await updateState(scratch.host, { managedVersion: "0.11.0" })).toEqual({
      managedVersion: "0.11.0",
      pin: "0.10.8",
    });
    expect(await readState(scratch.host)).toEqual({
      managedVersion: "0.11.0",
      pin: "0.10.8",
    });
  });
});
