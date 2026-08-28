import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import path from "node:path";

/**
 * The unit suite must run on a machine with no CBM executable and no network.
 *
 * That is a property of the suite rather than of any one test, so it is checked
 * the only way a property of a suite can be: by refusing the mechanisms through
 * which a unit test could reach either. A test that needs a real executable
 * belongs in a job that has one; a test that needs the network belongs nowhere
 * in this package.
 *
 * What this instrument is, stated rather than implied: a blocklist of named
 * mechanisms, matched as text -- a literal token, or a regex spelling out the
 * same mechanism's other forms -- over every module under `test/` bar the
 * sibling suite's own tests.
 *
 * Reading the whole tree, rather than the collected files plus a remembered
 * list of helper directories, is the correction to a measured miss. Both
 * ordinary places a helper lands -- beside the test that grew it
 * (`test/unit/x-helper.ts`), or beside the fixtures it reads
 * (`test/fixtures/x-helper.ts`) -- were reconstructed carrying `Bun.spawn`, and
 * both scanned clean while the roots were a hand-kept pair. Remembering to add
 * the next directory is not something a gate may depend on.
 *
 * What it is not is a proof of isolation. Two limits, the first measured on
 * this tree rather than supposed:
 *
 * - It matches spellings, not meanings. `const f = globalThis.fetch` followed
 *   by `f(url)` passes, because the alias carries no `(` after `fetch`. So does
 *   `await import("../../src/harvest/" + tail)`, and so does the same path
 *   assembled and handed to `createRequire`. Banning `import(` and
 *   `createRequire(` outright was tried and withdrawn: it closes two spellings
 *   of an unbounded set, leaves the alias -- which has no substring to match at
 *   all -- untouched, and buys that with an exemption owed by the next unit
 *   test that legitimately imports dynamically. Closing this class needs the
 *   module graph, not a substring, and a scan that claimed to have closed it
 *   would be worse than one that says it has not.
 * - A mechanism nobody has listed passes, and the answer is to add it here once
 *   it is known.
 *
 * What it does deliver: the listed mechanisms, spelled the ordinary way, cannot
 * be reopened silently from anywhere on the test side, and the scanned set is
 * derived from the tree rather than hand-kept, so a new file -- or a new
 * directory of them -- arrives gated.
 *
 * The instrument judges mechanisms, not intent, and its boundaries are named
 * below rather than left to be discovered:
 *
 * - `fetchHttps` is network-capable and is deliberately permitted. Its one call
 *   in this suite asserts a refusal that happens before any connection is
 *   opened, which is exactly the behaviour a unit test should cover.
 * - {@link EXEMPT} names each file allowed to carry a refused mechanism, and the
 *   reason. This file is one of them, because it necessarily writes every token
 *   it refuses.
 * - A banned token inside a string literal or a comment is still reported. The
 *   scan does not parse, and a false positive that costs a rename is a better
 *   trade than a parser that could be walked past.
 */

/** Everything the unit suite can reach on the test side, which is this file's tree, whole. */
const TEST_DIR = path.join(import.meta.dir, "..");

/**
 * Every module spelling Bun executes, as one list because both patterns below
 * need the same one.
 *
 * Enumerated rather than "anything with an extension", so a fixture named
 * `x.json` or a recorded `x.txt` is not read as a module. `mjs` and `cjs` are
 * here because leaving them out was a measured miss and not a theoretical one:
 * `test/unit/zz-helper.mjs` exporting a `Bun.spawnSync` call, imported by a
 * `.test.ts` beside it, scanned clean while the spawn really ran inside this
 * suite -- and `.cjs` behaved identically. Two lists that must agree is how the
 * omission survived a round, so there is now one.
 */
const MODULE_EXTENSIONS = "ts|tsx|js|jsx|mjs|cjs|mts|cts";

/** Every module, since a banned mechanism is just as reachable through an import as inline. */
const MODULE = new RegExp(String.raw`\.(${MODULE_EXTENSIONS})$`, "u");

/**
 * Every spelling `bun test` collects, which is how a sibling suite's own tests
 * are told from any other module. Measured on bun 1.3.14: a `.test.mjs` and a
 * `.test.cjs` in one directory are both collected and run.
 */
const COLLECTED = new RegExp(String.raw`\.(test|spec)\.(${MODULE_EXTENSIONS})$`, "u");

/**
 * The suite directories under `test/` this gate does not speak for.
 *
 * `bun test test/packaging` is a different job with different needs -- it loads
 * built bundles, and a future test there may legitimately have to start one --
 * so its collected tests are out of scope. Only those: a module merely parked
 * under such a directory is still scanned, because a unit test can import one
 * from anywhere and the directory it sits in changes nothing about that.
 */
const OTHER_SUITES = ["packaging/"];

/** A readdir path as a label: forward slashes on every platform, so an exemption key is portable. */
const relabel = (relative: string): string => relative.split(path.sep).join("/");

const SELF = relabel(path.relative(TEST_DIR, import.meta.path));

/**
 * A call to `fetch`, however it is reached.
 *
 * The first alternative is the identifier called directly, including through an
 * object: `globalThis.fetch(…)` and `window.fetch(…)` both match, which the
 * previous `(?<![\w.])` lookbehind excluded outright and so let straight
 * through. The second is the computed form, `globalThis["fetch"](…)`.
 * `fetchHttps` is a different identifier and matches neither.
 */
const FETCH_CALL = /(?<![\w$])fetch\s*\(|\[\s*(["'`])fetch\1\s*\]/u;

interface Banned {
  /** The literal token to refuse, and the name an exemption is granted by. */
  readonly token: string;
  /** A wider spelling of the same mechanism, when the literal token misses some of them. */
  readonly pattern?: RegExp;
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
    token: "Bun.spawn",
    reason:
      "it starts a process directly, outside the scratch `PATH` a resolution test sets up; the token is written " +
      "without its parenthesis so `Bun.spawnSync` is refused by the same entry",
  },
  {
    token: "fetch(",
    pattern: FETCH_CALL,
    reason: "the unit suite opens no connections, and a global reached through an object is still that global",
  },
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

/**
 * The files allowed to carry a refused mechanism, and why.
 *
 * Keyed by the same label a violation is reported under, so an exemption granted
 * to one file cannot be inherited by a new one beside it, and per token rather
 * than per file, so a licence for one mechanism is not a licence for the rest.
 * Every entry is a claim somebody wrote down and a reviewer can argue with,
 * which is the point: the alternative is a scan quietly weakened until it
 * reports nothing.
 */
const EXEMPT: Readonly<Record<string, readonly string[]>> = {
  [SELF]: BANNED.map(({ token }) => token),
  // A source string handed to `bun -e`, which spawns `sleep` to build the
  // escaping descendant `run`'s deadline has to survive. No CBM executable, no
  // PATH lookup, no connection.
  "unit/exec.test.ts": ["Bun.spawn"],
};

interface Scanned {
  /** How the file is reported and exempted: its path below `test/`, forward-slashed. */
  readonly label: string;
  readonly file: string;
}

/** Every module under `test/`, which is every file on the test side a unit test can reach. */
async function scanned(): Promise<readonly Scanned[]> {
  const entries = await readdir(TEST_DIR, { recursive: true });

  return entries
    // Matched against the returned relative path rather than a basename,
    // because the walk is recursive and a file at `test/unit/<sub>/x.test.ts`
    // would otherwise run unscanned.
    .filter((relative) => MODULE.test(relative))
    .map((relative) => ({ label: relabel(relative), file: path.join(TEST_DIR, relative) }))
    .filter(({ label }) => !(COLLECTED.test(label) && OTHER_SUITES.some((dir) => label.startsWith(dir))))
    .sort((left, right) => left.label.localeCompare(right.label));
}

test("no test in the unit suite requires a CBM executable or the network", async () => {
  const files = await scanned();

  // A scan that has stopped matching must not read as a scan that found
  // nothing wrong -- the failure mode this repository's hygiene job names.
  // Both directories that must never be empty are asserted, because either one
  // silently emptying is the same defect. `fixtures/` is not asserted: it holds
  // recorded documents and legitimately contains no module at all, which is
  // exactly why a helper parked there went unread for a round.
  expect(files.filter(({ label }) => label.startsWith("unit/")).length).toBeGreaterThan(0);
  expect(files.filter(({ label }) => label.startsWith("support/")).length).toBeGreaterThan(0);

  const violations: string[] = [];
  for (const { label, file } of files) {
    const exempt = EXEMPT[label] ?? [];
    const source = await Bun.file(file).text();
    for (const { token, pattern, reason } of BANNED) {
      if (exempt.includes(token)) continue;
      const found = pattern === undefined ? source.includes(token) : pattern.test(source);
      if (found) violations.push(`${label}: \`${token}\` -- ${reason}`);
    }
  }

  expect(violations).toEqual([]);
});

test("every exemption names a file that is scanned and a mechanism that is still refused", async () => {
  // An exemption outliving its file, or naming a token the blocklist no longer
  // carries, is a licence nobody can see being spent. Both read as "the scan
  // passed", which is the one thing this file may not do quietly.
  const labels = new Set((await scanned()).map(({ label }) => label));
  const tokens = new Set(BANNED.map(({ token }) => token));

  for (const [label, exempted] of Object.entries(EXEMPT)) {
    expect(labels.has(label)).toBe(true);
    for (const token of exempted) expect(tokens.has(token)).toBe(true);
  }
});
