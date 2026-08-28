import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { acquire, normalizeVersion, repairMacOsSignature } from "../../src/acquire.ts";
import { describeTarget } from "../../src/platform.ts";
import { managedBinRoot, managedExecutable, packageRoot } from "../../src/paths.ts";
import {
  buildArchive,
  dropBuiltArchives,
  fakeSource,
  releaseMembers,
  type BuiltArchive,
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
const NEWER = "0.11.0";
const TAG = `v${VERSION}`;

let scratch: Scratch;

beforeEach(async () => {
  // Acquisition shells out to `tar`, and on macOS to `xattr` and `codesign`.
  scratch = await makeScratch({ systemTools: true });
});

afterEach(async () => {
  await dropScratch(scratch);
});

afterAll(() => {
  dropBuiltArchives();
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
   * The digest `checksums.txt` publishes, resolved from the built archive.
   *
   * A column rather than a sentinel the body decodes: every case but the
   * mismatch publishes the archive's own digest, and a literal is how the
   * mismatch path is reached without also corrupting the archive.
   */
  readonly publishedDigest: (archive: BuiltArchive) => string;
  /** The text the refusal must name. */
  readonly reported: RegExp;
}

const aborts: AbortCase[] = [
  {
    scenario: "a digest mismatch aborts and names both digests",
    members: (target) => releaseMembers(target, VERSION),
    publishedDigest: () => "0".repeat(64),
    reported: /SHA-256 mismatch for .*: published 0{64}, downloaded [0-9a-f]{64}/u,
  },
  {
    scenario: "an unexpected archive member aborts before extraction",
    members: (target) => [
      ...releaseMembers(target, VERSION),
      { name: "postinstall.sh", contents: "#!/bin/sh\nexit 0\n", mode: 0o755 },
    ],
    publishedDigest: (archive) => archive.digest,
    reported: /unexpected member: "postinstall\.sh"/u,
  },
  {
    scenario: "a duplicated archive member aborts rather than last-one-wins",
    members: (target) => [...releaseMembers(target, VERSION), { name: "LICENSE", contents: "MIT\n" }],
    publishedDigest: (archive) => archive.digest,
    reported: /contains member LICENSE 2 times/u,
  },
  {
    scenario: "a missing archive member aborts",
    members: (target) => releaseMembers(target, VERSION).filter((m) => m.name !== "LICENSE"),
    publishedDigest: (archive) => archive.digest,
    reported: /missing member: LICENSE/u,
  },
  {
    scenario: "a symlinked executable aborts even though its name is expected",
    members: (target) => [
      ...releaseMembers(target, VERSION).filter((m) => m.name !== target.executable),
      { name: target.executable, symlinkTo: "/bin/sh" },
    ],
    publishedDigest: (archive) => archive.digest,
    reported: /not a regular file: codebase-memory-mcp/u,
  },
  {
    scenario: "an executable that fails --version aborts before adoption",
    members: (target) => [
      ...releaseMembers(target, VERSION).filter((m) => m.name !== target.executable),
      { name: target.executable, contents: "#!/bin/sh\nexit 3\n", mode: 0o755 },
    ],
    publishedDigest: (archive) => archive.digest,
    reported: /failed to run `--version`/u,
  },
  {
    // `./`, `/`, and a whitespace-only name are all real tar spellings, and all
    // three collapsed to the empty string under the previous normalization and
    // were skipped -- which let an archive holding a fifth member satisfy a
    // four-member closed set. This is the one of the three a real file on disk
    // can be made to produce.
    scenario: "a member whose name is only whitespace is refused rather than skipped",
    members: (target) => [...releaseMembers(target, VERSION), { name: " ", contents: "ws\n" }],
    publishedDigest: (archive) => archive.digest,
    reported: /unexpected member: " "/u,
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
      publishedDigest: publishedDigest(archive),
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

  test("the ./ spelling every tar writes for a member is accepted", async () => {
    const members = releaseMembers(TARGET, VERSION).map((member) => ({
      ...member,
      name: `./${member.name}`,
    }));
    const archive = await buildArchive(TARGET.archive, members);
    const source = fakeSource({
      tag: TAG,
      archiveName: TARGET.archive,
      bytes: archive.bytes,
      publishedDigest: archive.digest,
    });

    const acquired = await acquire({ host: scratch.host, target: TARGET, source });

    expect(acquired.version).toBe(VERSION);
    expect(await Bun.file(acquired.executable).exists()).toBe(true);
  });

  test("adopting a newer version leaves the previous version's executable in place", async () => {
    const first = await buildArchive(TARGET.archive, releaseMembers(TARGET, VERSION));
    await acquire({
      host: scratch.host,
      target: TARGET,
      source: fakeSource({
        tag: TAG,
        archiveName: TARGET.archive,
        bytes: first.bytes,
        publishedDigest: first.digest,
      }),
    });

    const second = await buildArchive(TARGET.archive, releaseMembers(TARGET, NEWER));
    const acquired = await acquire({
      host: scratch.host,
      target: TARGET,
      source: fakeSource({
        tag: `v${NEWER}`,
        archiveName: TARGET.archive,
        bytes: second.bytes,
        publishedDigest: second.digest,
      }),
    });

    expect(acquired.version).toBe(NEWER);
    expect(await Bun.file(managedExecutable(scratch.host, NEWER)).exists()).toBe(true);
    // The previous version is what resolution falls back to if the pointer
    // update does not land, so adopting over it is a worse failure than not
    // adopting at all.
    expect(await Bun.file(managedExecutable(scratch.host, VERSION)).exists()).toBe(true);
  });

  test("re-adopting a version replaces its executable instead of rewriting it in place", async () => {
    const archive = await buildArchive(TARGET.archive, releaseMembers(TARGET, VERSION));
    const source = fakeSource({
      tag: TAG,
      archiveName: TARGET.archive,
      bytes: archive.bytes,
      publishedDigest: archive.digest,
    });

    const first = await acquire({ host: scratch.host, target: TARGET, source });
    const before = await stat(first.executable);
    const second = await acquire({ host: scratch.host, target: TARGET, source });
    const after = await stat(second.executable);

    // A different inode is the observable difference between "staged, then
    // committed by one rename" and "written straight onto the live path". Only
    // the first leaves the previously resolved executable whole when the write
    // or the chmod behind it fails.
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o755);
  });

  test("a scratch directory that cannot be removed does not fail a committed adoption", async () => {
    // The smoke check runs the candidate, which is the only place a test can
    // reach acquisition's own temporary directory. The candidate reports its
    // directory and then makes it unremovable, so the `finally` cleanup fails
    // after the executable has already been adopted.
    const marker = path.join(scratch.root, "candidate-dir");
    const members: Member[] = [
      {
        name: TARGET.executable,
        mode: 0o755,
        contents:
          `#!/bin/sh\necho "codebase-memory-mcp ${VERSION}"\n` +
          `dir=$(dirname "$0")\nprintf '%s' "$dir" > "${marker}"\nchmod 0500 "$dir"\n`,
      },
      ...releaseMembers(TARGET, VERSION).filter((member) => member.name !== TARGET.executable),
    ];
    const archive = await buildArchive(TARGET.archive, members);
    const source = fakeSource({
      tag: TAG,
      archiveName: TARGET.archive,
      bytes: archive.bytes,
      publishedDigest: archive.digest,
    });

    try {
      const acquired = await acquire({ host: scratch.host, target: TARGET, source });
      expect(await Bun.file(acquired.executable).exists()).toBe(true);
    } finally {
      if (await Bun.file(marker).exists()) {
        const locked = await Bun.file(marker).text();
        await chmod(locked, 0o700);
        await rm(locked, { recursive: true, force: true });
      }
    }
  });
});

/**
 * `xattr` and `codesign` exist only on macOS, and `run` resolves them from the
 * process's own `PATH` rather than the scratch one, so this pair cannot be
 * substituted. A path that does not exist is what makes both tools fail for a
 * reason the test controls.
 */
describe.skipIf(process.platform !== "darwin")("the macOS repair step", () => {
  test("a failed quarantine removal is refused rather than read as a missing attribute", async () => {
    const missing = path.join(scratch.root, "not-extracted", "codebase-memory-mcp");

    // Named `xattr`, not `codesign`: before the fix the discarded `xattr`
    // result let the failure surface two steps later as a signing failure,
    // which reports the wrong cause and only by accident reports at all.
    await expect(repairMacOsSignature(scratch.host, missing)).rejects.toThrow(
      /could not clear the candidate's extended attributes/u,
    );
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
