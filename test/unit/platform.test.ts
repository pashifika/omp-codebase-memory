import { describe, expect, test } from "bun:test";

import {
  describeTarget,
  detectTarget,
  UnsupportedPlatformError,
  type TargetArch,
  type TargetOs,
} from "../../src/platform.ts";

/**
 * Every asset name `checksums.txt` listed for v0.10.8.
 *
 * Read from the recorded fixture rather than rebuilt from a template: the
 * property under test is that this package's construction agrees with what
 * upstream actually published, and a table built the same way as the
 * implementation would agree with a typo in it too.
 */
const PUBLISHED_NAMES = new Set(
  (await Bun.file("test/fixtures/checksums-v0.10.8.txt").text())
    .split("\n")
    .map((line) => line.trim().split(/\s+/u)[1])
    .filter((name): name is string => name !== undefined),
);

interface ArchiveNameCase {
  readonly scenario: string;
  readonly os: TargetOs;
  readonly arch: TargetArch;
  /** The asset name upstream publishes for this pair. */
  readonly archive: string;
  /**
   * Whether the name carries the `-portable` suffix.
   *
   * Linux must: the standard Linux build dynamically links glibc 2.38 or newer
   * and fails on Debian 11, RHEL 8, and Ubuntu 20.04. macOS must not: no such
   * variant is published, so a suffix there names nothing.
   */
  readonly portable: boolean;
  /** Whether the name appears in the recorded published fixture. */
  readonly published: boolean;
}

const archiveNames: ArchiveNameCase[] = [
  {
    scenario: "darwin/arm64 selects the plain macOS archive",
    os: "darwin",
    arch: "arm64",
    archive: "codebase-memory-mcp-darwin-arm64.tar.gz",
    portable: false,
    published: true,
  },
  {
    scenario: "darwin/amd64 selects the plain macOS archive",
    os: "darwin",
    arch: "amd64",
    archive: "codebase-memory-mcp-darwin-amd64.tar.gz",
    portable: false,
    published: true,
  },
  {
    scenario: "linux/arm64 selects the portable Linux archive",
    os: "linux",
    arch: "arm64",
    archive: "codebase-memory-mcp-linux-arm64-portable.tar.gz",
    portable: true,
    published: true,
  },
  {
    scenario: "linux/amd64 selects the portable Linux archive",
    os: "linux",
    arch: "amd64",
    archive: "codebase-memory-mcp-linux-amd64-portable.tar.gz",
    portable: true,
    published: true,
  },
  {
    // Described so a later change extends one seam rather than reverse-engineering
    // the naming; `detectTarget` refuses the platform, so nothing acquires it.
    scenario: "windows/amd64 names the zip archive it does not yet support",
    os: "windows",
    arch: "amd64",
    archive: "codebase-memory-mcp-windows-amd64.zip",
    portable: false,
    published: true,
  },
];

interface ArchiveContentsCase {
  readonly scenario: string;
  readonly os: TargetOs;
  readonly arch: TargetArch;
  readonly container: "tar.gz" | "zip";
  readonly executable: string;
  /** The closed member set, sorted; anything outside it is an integrity failure. */
  readonly members: readonly string[];
}

const archiveContents: ArchiveContentsCase[] = [
  {
    scenario: "a POSIX target names the executable, licence, shell installer and notices",
    os: "darwin",
    arch: "arm64",
    container: "tar.gz",
    executable: "codebase-memory-mcp",
    members: ["LICENSE", "THIRD_PARTY_NOTICES.md", "codebase-memory-mcp", "install.sh"],
  },
  {
    scenario: "a Windows target names the .exe and the PowerShell installer",
    os: "windows",
    arch: "amd64",
    container: "zip",
    executable: "codebase-memory-mcp.exe",
    members: ["LICENSE", "THIRD_PARTY_NOTICES.md", "codebase-memory-mcp.exe", "install.ps1"],
  },
];

interface DetectionCase {
  readonly scenario: string;
  /** `process.platform` as the host reports it. */
  readonly platform: string;
  /** `process.arch` as the host reports it. */
  readonly arch: string;
  /** `os.cpus()[0]?.model`, which is how Rosetta is detected. */
  readonly cpuModel: string | undefined;
  readonly expected: string;
}

const detections: DetectionCase[] = [
  {
    scenario: "an arm64 process on Apple Silicon resolves natively",
    platform: "darwin",
    arch: "arm64",
    cpuModel: "Apple M1 Pro",
    expected: "codebase-memory-mcp-darwin-arm64.tar.gz",
  },
  {
    scenario: "an x64 process on Apple Silicon is corrected to arm64 rather than translated",
    platform: "darwin",
    arch: "x64",
    cpuModel: "Apple M1 Pro",
    expected: "codebase-memory-mcp-darwin-arm64.tar.gz",
  },
  {
    scenario: "an x64 process on an Intel Mac stays amd64",
    platform: "darwin",
    arch: "x64",
    cpuModel: "Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz",
    expected: "codebase-memory-mcp-darwin-amd64.tar.gz",
  },
  {
    scenario: "Linux never applies the Rosetta correction, whatever the brand string says",
    platform: "linux",
    arch: "x64",
    cpuModel: "Apple M1 Pro",
    expected: "codebase-memory-mcp-linux-amd64-portable.tar.gz",
  },
  {
    scenario: "a missing brand string leaves an x64 Mac on amd64",
    platform: "darwin",
    arch: "x64",
    cpuModel: undefined,
    expected: "codebase-memory-mcp-darwin-amd64.tar.gz",
  },
];

interface RefusalCase {
  readonly scenario: string;
  readonly platform: string;
  readonly arch: string;
  /** The text the refusal must name, so the operator knows what to do next. */
  readonly reported: RegExp;
}

const refusals: RefusalCase[] = [
  {
    scenario: "Windows is refused explicitly rather than half-implemented",
    platform: "win32",
    arch: "x64",
    reported: /Windows is not supported yet/u,
  },
  {
    scenario: "an unsupported operating system is refused by name",
    platform: "freebsd",
    arch: "arm64",
    reported: /unsupported operating system: freebsd/u,
  },
  {
    scenario: "an unsupported architecture is refused by name",
    platform: "linux",
    arch: "riscv64",
    reported: /unsupported architecture: riscv64/u,
  },
];

test("every case names itself distinctly", () => {
  const scenarios = [
    ...archiveNames,
    ...archiveContents,
    ...detections,
    ...refusals,
  ].map((entry) => entry.scenario);
  expect(new Set(scenarios).size).toBe(scenarios.length);
});

describe("archive name construction", () => {
  test.each(archiveNames)("$scenario", ({ os, arch, archive, portable, published }) => {
    const target = describeTarget(os, arch);
    expect(target.archive).toBe(archive);
    expect(target.archive.includes("-portable")).toBe(portable);
    expect(PUBLISHED_NAMES.has(target.archive)).toBe(published);
  });
});

describe("archive contents", () => {
  test.each(archiveContents)("$scenario", ({ os, arch, container, executable, members }) => {
    const target = describeTarget(os, arch);
    expect(target.container).toBe(container);
    expect(target.executable).toBe(executable);
    expect([...target.members].sort()).toEqual([...members]);
  });
});

describe("host detection", () => {
  test.each(detections)("$scenario", ({ platform, arch, cpuModel, expected }) => {
    expect(detectTarget(platform, arch, cpuModel).archive).toBe(expected);
  });

  test.each(refusals)("$scenario", ({ platform, arch, reported }) => {
    expect(() => detectTarget(platform, arch, undefined)).toThrow(UnsupportedPlatformError);
    expect(() => detectTarget(platform, arch, undefined)).toThrow(reported);
  });
});
