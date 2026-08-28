/**
 * The one seam that knows how a release asset is named and what it contains.
 *
 * Every platform-specific fact about upstream's release layout lives here:
 * archive naming, the container format, the executable's name inside it, and
 * the closed member set the archive must match. Acquisition, verification, and
 * resolution all read those facts from a {@link Target} rather than deriving
 * them again, so adding a platform means extending this file and nothing else.
 */
import { cpus } from "node:os";

/** The operating systems upstream publishes an archive for. */
export type TargetOs = "darwin" | "linux" | "windows";

/** The architectures upstream publishes an archive for. */
export type TargetArch = "arm64" | "amd64";

/** Everything downstream code needs to know about one release target. */
export interface Target {
  readonly os: TargetOs;
  readonly arch: TargetArch;
  /** Release asset name, exactly as `checksums.txt` spells it. */
  readonly archive: string;
  /** Container format, which decides the enumeration and extraction tool. */
  readonly container: "tar.gz" | "zip";
  /** The executable's name inside the archive, and on disk once adopted. */
  readonly executable: string;
  /** The platform installer script inside the archive. */
  readonly installer: string;
  /**
   * The complete set of members the archive may contain, in no particular
   * order. Upstream's installer treats anything outside it as a release
   * integrity failure rather than a sidecar to ignore, and so does this
   * package; see {@link enumerateArchiveMembers}.
   */
  readonly members: readonly string[];
}

/**
 * Raised for a platform this package names but does not implement.
 *
 * Windows reaches this: {@link describeTarget} knows its archive naming, so a
 * later change has one seam to extend rather than a shape to reverse-engineer,
 * but zip extraction, the executable suffix on disk, and Windows path handling
 * are absent. One explicit refusal is honest about that; a half-implemented
 * branch would download an archive it cannot open.
 */
export class UnsupportedPlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedPlatformError";
  }
}

/**
 * The release target for one OS/architecture pair.
 *
 * Pure, and deliberately total over {@link TargetOs}: the Windows shape is
 * described here and refused in {@link detectTarget}, which keeps the naming
 * under test without claiming support for it.
 *
 * The Linux `-portable` suffix is not cosmetic. The standard Linux build
 * dynamically links glibc 2.38 or newer and fails outright on Debian 11,
 * RHEL 8, and Ubuntu 20.04; the portable build is fully static. macOS and
 * Windows publish no such variant, so the suffix must be absent there or the
 * asset name names nothing.
 */
export function describeTarget(os: TargetOs, arch: TargetArch): Target {
  const container = os === "windows" ? "zip" : "tar.gz";
  const executable = os === "windows" ? "codebase-memory-mcp.exe" : "codebase-memory-mcp";
  const installer = os === "windows" ? "install.ps1" : "install.sh";
  const portable = os === "linux" ? "-portable" : "";
  const archive = `codebase-memory-mcp-${os}-${arch}${portable}.${container}`;

  return {
    os,
    arch,
    archive,
    container,
    executable,
    installer,
    members: [executable, "LICENSE", installer, "THIRD_PARTY_NOTICES.md"],
  };
}

/**
 * The release target for the host this process runs on.
 *
 * `platform` and `arch` are `process.platform` and `process.arch`; `cpuModel`
 * is the host's CPU brand string (`os.cpus()[0]?.model`). The last one exists
 * for Rosetta: an x64 process on Apple Silicon reports `arch === "x64"`, and
 * selecting the amd64 archive there installs a translated binary that works
 * but runs slowly beside a native one. Upstream's installer makes the same
 * correction from the same brand string.
 */
export function detectTarget(platform: string, arch: string, cpuModel: string | undefined): Target {
  let os: TargetOs;
  switch (platform) {
    case "darwin":
      os = "darwin";
      break;
    case "linux":
      os = "linux";
      break;
    case "win32":
      throw new UnsupportedPlatformError(
        "Windows is not supported yet: the release archive is a zip this package cannot extract, " +
          "and the executable suffix and path handling are unimplemented. " +
          "Install codebase-memory-mcp with upstream's install.ps1 and this package will adopt it from PATH.",
      );
    default:
      throw new UnsupportedPlatformError(
        `unsupported operating system: ${platform} (supported: darwin, linux)`,
      );
  }

  let target: TargetArch;
  switch (arch) {
    case "arm64":
      target = "arm64";
      break;
    case "x64":
      target = os === "darwin" && /apple/i.test(cpuModel ?? "") ? "arm64" : "amd64";
      break;
    default:
      throw new UnsupportedPlatformError(
        `unsupported architecture: ${arch} (supported: arm64, x64)`,
      );
  }

  return describeTarget(os, target);
}

/** The release target for this process, read from `process` and `os.cpus()`. */
export function hostTarget(): Target {
  return detectTarget(process.platform, process.arch, cpus()[0]?.model);
}
