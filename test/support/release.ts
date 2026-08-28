import { chmod, mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { run } from "../../src/exec.ts";
import type { ReleaseSource } from "../../src/release.ts";
import type { Target } from "../../src/platform.ts";

/**
 * Release archives built with the same `tar` acquisition reads them with.
 *
 * A hand-written archive parser in the test would agree with a hand-written one
 * in the source; a real archive built by the real tool is what makes "reject an
 * unexpected member" and "reject a symlinked member" claims about behaviour
 * rather than about two implementations of the same guess.
 */

/** One member of a built archive. */
export interface Member {
  readonly name: string;
  /** File contents; mutually exclusive with {@link Member.symlinkTo}. */
  readonly contents?: string;
  /** Makes the member a symbolic link to this target instead of a file. */
  readonly symlinkTo?: string;
  readonly mode?: number;
}

/** An archive on disk, with its digest. */
export interface BuiltArchive {
  readonly file: string;
  readonly bytes: Uint8Array;
  readonly digest: string;
}

/**
 * The four members a genuine release archive holds, with an executable that
 * runs and prints `version`.
 */
export function releaseMembers(target: Target, version: string): Member[] {
  return [
    {
      name: target.executable,
      contents: `#!/bin/sh\necho "codebase-memory-mcp ${version}"\n`,
      mode: 0o755,
    },
    { name: "LICENSE", contents: "MIT\n" },
    { name: target.installer, contents: "#!/usr/bin/env bash\nexit 0\n", mode: 0o755 },
    { name: "THIRD_PARTY_NOTICES.md", contents: "# notices\n" },
  ];
}

/** Builds a `.tar.gz` holding exactly `members`. */
export async function buildArchive(name: string, members: readonly Member[]): Promise<BuiltArchive> {
  const staging = await mkdtemp(path.join(tmpdir(), "cbm-archive-"));
  const content = path.join(staging, "content");
  await mkdir(content, { recursive: true });

  for (const member of members) {
    const entry = path.join(content, member.name);
    await mkdir(path.dirname(entry), { recursive: true });
    if (member.symlinkTo !== undefined) {
      await symlink(member.symlinkTo, entry);
      continue;
    }
    await Bun.write(entry, member.contents ?? "");
    if (member.mode !== undefined) await chmod(entry, member.mode);
  }

  const file = path.join(staging, name);
  const packed = await run([
    "tar",
    "-czf",
    file,
    "-C",
    content,
    ...members.map((member) => member.name),
  ]);
  if (!packed.ok) {
    throw new Error(`could not build ${name}: ${packed.stderr || packed.spawnError}`);
  }

  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return { file, bytes, digest: hasher.digest("hex") };
}

export interface FakeSourceOptions {
  readonly tag: string;
  readonly archiveName: string;
  readonly bytes: Uint8Array;
  /**
   * The digest `checksums.txt` publishes. Defaults to the archive's real
   * digest; a different value is how the mismatch path is reached.
   */
  readonly publishedDigest: string;
}

/** A {@link ReleaseSource} serving one prepared archive, with a call log. */
export interface FakeSource extends ReleaseSource {
  /** Every asset name requested, in order. */
  readonly requested: string[];
}

export function fakeSource(options: FakeSourceOptions): FakeSource {
  const requested: string[] = [];
  const encoder = new TextEncoder();
  return {
    requested,
    latestTag: async () => options.tag,
    checksums: async () =>
      encoder.encode(`${options.publishedDigest}  ${options.archiveName}\n`),
    asset: async (_tag, name) => {
      requested.push(name);
      if (name !== options.archiveName) throw new Error(`no such asset: ${name}`);
      return options.bytes;
    },
  };
}
