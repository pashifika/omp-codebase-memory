import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

import { acquire, normalizeVersion } from "../../src/acquire.ts";
import { describeTarget } from "../../src/platform.ts";
import { managedBinRoot, packageRoot } from "../../src/paths.ts";
import {
  buildArchive,
  fakeSource,
  releaseMembers,
  type Member,
} from "../support/release.ts";
import { dropScratch, makeScratch, type Scratch } from "../support/scratch.ts";

/**
 * The host target is used rather than a fixed one so the macOS repair branch --
 * `xattr` then `codesign` -- is exercised where it exists and skipped where it
 * does not. Both are the real path for the machine running the suite.
 */
const TARGET = describeTarget(process.platform === "darwin" ? "darwin" : "linux", "arm64");
const VERSION = "0.10.8";
const TAG = `v${VERSION}`;

let scratch: Scratch;

beforeEach(async () => {
  // Acquisition shells out to `tar`, and on macOS to `xattr` and `codesign`.
  scratch = await makeScratch({ systemTools: true });
});

afterEach(async () => {
  await dropScratch(scratch);
});

/** Whether anything at all exists under the root this package owns. */
async function packageRootEntries(): Promise<string[]> {
  try {
    return await readdir(packageRoot(scratch.host));
  } catch {
    return [];
  }
}

interface AbortCase {
  readonly scenario: string;
  /** The archive members, which is what each failure is really about. */
  readonly members: (target: typeof TARGET) => Member[];
  /**
   * The digest `checksums.txt` publishes.
   *
   * `"real"` publishes the archive's own digest; a literal is how the mismatch
   * path is reached without also corrupting the archive.
   */
  readonly publishedDigest: "real" | string;
  /** The text the refusal must name. */
  readonly reported: RegExp;
}

const aborts: AbortCase[] = [
  {
    scenario: "a digest mismatch aborts and names both digests",
    members: (target) => releaseMembers(target, VERSION),
    publishedDigest: "0".repeat(64),
    reported: /SHA-256 mismatch for .*: published 0{64}, downloaded [0-9a-f]{64}/u,
  },
  {
    scenario: "an unexpected archive member aborts before extraction",
    members: (target) => [
      ...releaseMembers(target, VERSION),
      { name: "postinstall.sh", contents: "#!/bin/sh\nexit 0\n", mode: 0o755 },
    ],
    publishedDigest: "real",
    reported: /unexpected member: postinstall\.sh/u,
  },
  {
    scenario: "a duplicated archive member aborts rather than last-one-wins",
    members: (target) => [...releaseMembers(target, VERSION), { name: "LICENSE", contents: "MIT\n" }],
    publishedDigest: "real",
    reported: /contains member LICENSE 2 times/u,
  },
  {
    scenario: "a missing archive member aborts",
    members: (target) => releaseMembers(target, VERSION).filter((m) => m.name !== "LICENSE"),
    publishedDigest: "real",
    reported: /missing member: LICENSE/u,
  },
  {
    scenario: "a symlinked executable aborts even though its name is expected",
    members: (target) => [
      ...releaseMembers(target, VERSION).filter((m) => m.name !== target.executable),
      { name: target.executable, symlinkTo: "/bin/sh" },
    ],
    publishedDigest: "real",
    reported: /not a regular file: codebase-memory-mcp/u,
  },
  {
    scenario: "an executable that fails --version aborts before adoption",
    members: (target) => [
      ...releaseMembers(target, VERSION).filter((m) => m.name !== target.executable),
      { name: target.executable, contents: "#!/bin/sh\nexit 3\n", mode: 0o755 },
    ],
    publishedDigest: "real",
    reported: /failed to run `--version`/u,
  },
];

test("every case names itself distinctly", () => {
  const scenarios = aborts.map((entry) => entry.scenario);
  expect(new Set(scenarios).size).toBe(scenarios.length);
});

describe("a failed acquisition writes nothing under the package-owned root", () => {
  test.each(aborts)("$scenario", async ({ members, publishedDigest, reported }) => {
    const archive = await buildArchive(TARGET.archive, members(TARGET));
    const source = fakeSource({
      tag: TAG,
      archiveName: TARGET.archive,
      bytes: archive.bytes,
      publishedDigest: publishedDigest === "real" ? archive.digest : publishedDigest,
    });

    const attempt = acquire({ host: scratch.host, target: TARGET, source });
    await expect(attempt).rejects.toThrow(reported);
    expect(await packageRootEntries()).toEqual([]);
  });
});

describe("a verified acquisition", () => {
  test("adopts the executable under bin/<version> and reports what it runs", async () => {
    const archive = await buildArchive(TARGET.archive, releaseMembers(TARGET, VERSION));
    const source = fakeSource({
      tag: TAG,
      archiveName: TARGET.archive,
      bytes: archive.bytes,
      publishedDigest: archive.digest,
    });

    const acquired = await acquire({ host: scratch.host, target: TARGET, source });

    expect(acquired.version).toBe(VERSION);
    expect(acquired.digest).toBe(archive.digest);
    expect(acquired.reportedVersion).toBe(`codebase-memory-mcp ${VERSION}`);
    expect(acquired.executable).toBe(
      `${managedBinRoot(scratch.host)}/${VERSION}/${TARGET.executable}`,
    );
    expect(await Bun.file(acquired.executable).exists()).toBe(true);
    expect(source.requested).toEqual([TARGET.archive]);
  });

  test("resolves the newest tag when no version is requested", async () => {
    const archive = await buildArchive(TARGET.archive, releaseMembers(TARGET, VERSION));
    const source = fakeSource({
      tag: TAG,
      archiveName: TARGET.archive,
      bytes: archive.bytes,
      publishedDigest: archive.digest,
    });

    expect((await acquire({ host: scratch.host, target: TARGET, source })).version).toBe(VERSION);
  });
});

interface VersionCase {
  readonly scenario: string;
  readonly input: string;
  readonly expected: string;
}

const versions: VersionCase[] = [
  { scenario: "a bare version passes through", input: "0.10.8", expected: "0.10.8" },
  { scenario: "a leading v is stripped", input: "v0.10.8", expected: "0.10.8" },
  { scenario: "surrounding whitespace is trimmed", input: "  v1.2.3  ", expected: "1.2.3" },
  {
    scenario: "a prerelease suffix survives",
    input: "v1.2.3-rc.1",
    expected: "1.2.3-rc.1",
  },
];

interface BadVersionCase {
  readonly scenario: string;
  readonly input: string;
}

/**
 * A version reaches the filesystem as a directory name and the network as a URL
 * segment, and it can arrive from a redirect's `location`. Each of these would
 * escape `bin/` or name something else entirely.
 */
const badVersions: BadVersionCase[] = [
  { scenario: "a parent-directory traversal is refused", input: "../../etc" },
  { scenario: "an embedded separator is refused", input: "1.0/../../evil" },
  { scenario: "an empty version is refused", input: "" },
  { scenario: "a version that is only a v is refused", input: "v" },
  { scenario: "a leading dot is refused", input: ".hidden" },
];

test("every version case names itself distinctly", () => {
  const scenarios = [...versions, ...badVersions].map((entry) => entry.scenario);
  expect(new Set(scenarios).size).toBe(scenarios.length);
});

describe("version normalization", () => {
  test.each(versions)("$scenario", ({ input, expected }) => {
    expect(normalizeVersion(input)).toBe(expected);
  });

  test.each(badVersions)("$scenario", ({ input }) => {
    expect(() => normalizeVersion(input)).toThrow(/not a usable version/u);
  });
});
