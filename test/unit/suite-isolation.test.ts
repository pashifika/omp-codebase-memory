import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import path from "node:path";

/**
 * The unit suite must run on a machine with no CBM executable and no network.
 *
 * That is a property of the suite rather than of any one test, so it is checked
 * the only way a property of a suite can be: by reading every file the runner
 * would collect and refusing the mechanisms through which a unit test could
 * reach either. A test that needs a real executable belongs in a job that has
 * one; a test that needs the network belongs nowhere in this package.
 *
 * The instrument judges mechanisms, not intent, and its boundaries are named
 * below rather than left to be discovered:
 *
 * - `fetchHttps` is network-capable and is deliberately permitted. Its one call
 *   in this suite asserts a refusal that happens before any connection is
 *   opened, which is exactly the behaviour a unit test should cover.
 * - This file is excluded from its own scan, because it necessarily writes the
 *   tokens it refuses.
 * - A banned token inside a string literal or a comment is still reported. The
 *   scan does not parse, and a false positive that costs a rename is a better
 *   trade than a parser that could be walked past.
 */

const UNIT_DIR = import.meta.dir;

/** Every spelling `bun test` collects, so a new file cannot arrive ungated. */
const COLLECTED = /\.(test|spec)\.(ts|tsx|js|jsx|mts|cts)$/u;

const SELF = path.basename(import.meta.path);

interface Banned {
  /** The literal token to refuse. */
  readonly token: string;
  /** Why a unit test may not contain it. */
  readonly reason: string;
}

const BANNED: Banned[] = [
  {
    token: "processHost(",
    reason: "it resolves the developer's real home directory and PATH, so a real CBM installation could decide the result",
  },
  { token: "Bun.which(", reason: "it searches the real PATH" },
  {
    token: "../../src/harvest/collect.ts",
    reason: "collection drives a real `install` invocation and belongs in the harvest job",
  },
  {
    token: "../../src/harvest/vocabulary.ts",
    reason: "the vocabulary is read from a real executable and belongs in the harvest job",
  },
  { token: "../../scripts/", reason: "the harvest entry point resolves and runs a real executable" },
];

/** A call to the global `fetch`, not a mention of `fetchHttps` or a `.fetch` method. */
const BARE_FETCH = /(?<![\w.])fetch\s*\(/u;

test("no test in the unit suite requires a CBM executable or the network", async () => {
  const files = (await readdir(UNIT_DIR)).filter((name) => COLLECTED.test(name) && name !== SELF).sort();

  // A scan that has stopped matching must not read as a scan that found
  // nothing wrong -- the failure mode this repository's hygiene job names.
  expect(files.length).toBeGreaterThan(0);

  const violations: string[] = [];
  for (const name of files) {
    const source = await Bun.file(path.join(UNIT_DIR, name)).text();
    for (const { token, reason } of BANNED) {
      if (source.includes(token)) violations.push(`${name}: \`${token}\` -- ${reason}`);
    }
    if (BARE_FETCH.test(source)) {
      violations.push(`${name}: a call to the global \`fetch\` -- the unit suite opens no connections`);
    }
  }

  expect(violations).toEqual([]);
});
