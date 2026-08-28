import type { Stats } from "node:fs";
import { chmod, lstat, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { haveTool, readVersion, run } from "./exec.ts";
import { managedBinRoot, type Host } from "./paths.ts";
import { parseChecksums, type ReleaseSource } from "./release.ts";
import { UnsupportedPlatformError, type Target } from "./platform.ts";

/**
 * Acquisition: everything between "there is a release" and "this package owns a
 * verified executable".
 *
 * The sequence reproduces upstream's `install.sh` step for step. Each step is
 * here because that installer has it, and each is a refusal rather than a
 * warning, because a step that merely warns is a verification property that has
 * been removed while still appearing to be present.
 *
 * Nothing is written under the package-owned root until every step has passed:
 * the candidate lives in a temporary directory, so a failure leaves whatever
 * executable was resolved before still resolved.
 */

/** What a completed acquisition produced. */
export interface Acquired {
  /** The version adopted, which is also its directory name under `bin/`. */
  readonly version: string;
  /** The archive digest it was verified against. */
  readonly digest: string;
  /** The adopted executable's absolute path. */
  readonly executable: string;
  /** What the adopted executable reports for `--version`. */
  readonly reportedVersion: string;
}

export interface AcquireRequest {
  readonly host: Host;
  readonly target: Target;
  readonly source: ReleaseSource;
  /**
   * The version to acquire. Omitted means the newest release, resolved through
   * the `releases/latest` redirect.
   */
  readonly version?: string;
}

/**
 * A version string that is safe as a URL segment and a directory name.
 *
 * Validated rather than trusted because the value can arrive from a redirect's
 * `location` or from an operator's `/cbm install 0.10.8`, and it is used for
 * both. Refusing `..` and separators here is what keeps a release tag from
 * naming a directory outside `bin/`.
 */
const VERSION_PATTERN = /^[0-9][0-9A-Za-z.+-]*$/u;

/** `v0.10.8` and `0.10.8` both mean version `0.10.8`. */
export function normalizeVersion(value: string): string {
  const trimmed = value.trim().replace(/^v/iu, "");
  if (!VERSION_PATTERN.test(trimmed)) {
    throw new Error(`not a usable version: ${value}`);
  }
  return trimmed;
}

/** The release tag for a normalized version. */
export function tagFor(version: string): string {
  return `v${version}`;
}

/**
 * Downloads, verifies, and adopts one release.
 *
 * @throws when any verification step fails, having written nothing under the
 * package-owned root.
 */
export async function acquire(request: AcquireRequest): Promise<Acquired> {
  const { host, target, source } = request;

  if (target.container !== "tar.gz") {
    throw new UnsupportedPlatformError(
      `cannot extract a ${target.container} archive; only tar.gz is implemented`,
    );
  }
  if (!haveTool("tar", host.env["PATH"])) {
    throw new Error("tar is required to extract the release archive, and is not on PATH");
  }

  const version =
    request.version === undefined
      ? normalizeVersion(await source.latestTag())
      : normalizeVersion(request.version);
  const tag = tagFor(version);

  const expected = parseChecksums(await source.checksums(tag), target.archive);
  const bytes = await source.asset(tag, target.archive);

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  const actual = hasher.digest("hex");
  if (actual !== expected) {
    throw new Error(
      `SHA-256 mismatch for ${target.archive} at ${tag}: published ${expected}, downloaded ${actual}`,
    );
  }

  const scratch = await mkdtemp(path.join(tmpdir(), "omp-codebase-memory-"));
  try {
    const archive = path.join(scratch, target.archive);
    await Bun.write(archive, bytes);

    await assertArchiveMembers(archive, target);
    await extract(archive, scratch, target);

    const candidate = path.join(scratch, target.executable);
    await chmod(candidate, 0o755);

    if (target.os === "darwin") await repairMacOsSignature(host, candidate);

    const reportedVersion = await smokeCheck(candidate, target);
    return await adopt(host, { version, digest: expected, candidate, reportedVersion });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Refuses any archive whose member list is not exactly the expected four.
 *
 * Enumerated before extraction, not after, because the point is to never write
 * an unexpected member to disk. Upstream's installer does the same, and treats
 * an extra member as a release-integrity failure rather than a sidecar to
 * ignore -- a fifth member means the archive is not the artifact this code
 * knows how to verify, whatever it contains.
 */
export async function assertArchiveMembers(archive: string, target: Target): Promise<void> {
  const listed = await run(["tar", "-tzf", archive]);
  if (!listed.ok) {
    throw new Error(
      `could not enumerate ${path.basename(archive)}: ${listed.stderr.trim() || listed.spawnError || `tar exited ${listed.exitCode}`}`,
    );
  }

  const seen = new Map<string, number>();
  for (const raw of listed.stdout.split("\n")) {
    const member = raw.trim().replace(/^\.\//u, "").replace(/\/+$/u, "");
    if (member === "") continue;
    if (!target.members.includes(member)) {
      throw new Error(`release archive contains unexpected member: ${member}`);
    }
    seen.set(member, (seen.get(member) ?? 0) + 1);
  }

  for (const member of target.members) {
    const count = seen.get(member) ?? 0;
    if (count === 1) continue;
    throw new Error(
      count === 0
        ? `release archive is missing member: ${member}`
        : `release archive contains member ${member} ${count} times`,
    );
  }
}

/**
 * Extracts into `into` and requires every member to be a plain regular file.
 *
 * `--no-same-owner` matches upstream's installer: without it a root extraction
 * would honour the ownership recorded in the archive. The symlink check is
 * separate from the member-name check above because a name can be in the closed
 * set while the entry it names is a link -- and a link is how an extraction is
 * made to write, or to be read from, somewhere it was never listed as touching.
 */
async function extract(archive: string, into: string, target: Target): Promise<void> {
  const extracted = await run(["tar", "--no-same-owner", "-xzf", archive, "-C", into]);
  if (!extracted.ok) {
    throw new Error(
      `could not extract ${path.basename(archive)}: ${extracted.stderr.trim() || extracted.spawnError || `tar exited ${extracted.exitCode}`}`,
    );
  }

  for (const member of target.members) {
    const entry = path.join(into, member);
    let stats: Stats;
    try {
      stats = await lstat(entry);
    } catch {
      throw new Error(`release member is missing after extraction: ${member}`);
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`release member is not a regular file: ${member}`);
    }
  }
}

/** The commands an operator can run by hand to repair a quarantined binary. */
function repairHint(candidate: string): string {
  return `xattr -cr ${candidate} && codesign --force --sign - ${candidate}`;
}

/**
 * Removes the quarantine attribute and applies an ad-hoc signature.
 *
 * Both are prerequisites rather than optional polish: an unsigned Mach-O binary
 * downloaded from the network is refused by Gatekeeper, and the resulting
 * failure is a kill signal with no message that explains it. Upstream's
 * installer does both and ignores their failures; this one reports a *missing
 * tool* by name, because that is a diagnosable host problem, while tolerating a
 * missing attribute, which is the normal case for an archive fetched over
 * HTTPS rather than by a browser.
 */
async function repairMacOsSignature(host: Host, candidate: string): Promise<void> {
  const pathEnv = host.env["PATH"];
  for (const tool of ["xattr", "codesign"] as const) {
    if (!haveTool(tool, pathEnv)) {
      throw new Error(
        `${tool} is required to prepare a macOS binary and is not on PATH; ` +
          `install the Xcode command line tools, or repair the candidate yourself with \`${repairHint(candidate)}\``,
      );
    }
  }

  // A missing attribute is the common case and prints "No such xattr" on stderr;
  // that is not a failure, so only the tool's absence above is refused.
  await run(["xattr", "-d", "com.apple.quarantine", candidate], { timeoutMs: 10_000 });

  const signed = await run(["codesign", "--sign", "-", "--force", candidate], {
    timeoutMs: 60_000,
  });
  if (!signed.ok) {
    throw new Error(
      `could not ad-hoc sign the candidate: ${signed.stderr.trim() || `codesign exited ${signed.exitCode}`}. ` +
        `Repair it by hand with \`${repairHint(candidate)}\``,
    );
  }
}

/**
 * Runs the candidate before anything depends on it.
 *
 * This is the step that catches a build for the wrong glibc, a truncated
 * download that still hashed correctly because the digest file was also
 * substituted, and a macOS binary the repair above did not fix. On macOS the
 * failure names the repair commands, because that is overwhelmingly the cause
 * and the operator can act on it directly.
 */
async function smokeCheck(candidate: string, target: Target): Promise<string> {
  const reported = await readVersion(candidate);
  if (reported !== null) return reported;

  const suffix =
    target.os === "darwin"
      ? ` If macOS is refusing to run it, try \`${repairHint(candidate)}\`.`
      : "";
  throw new Error(`the downloaded executable failed to run \`--version\`.${suffix}`);
}

/**
 * Places the verified candidate under the package-owned root.
 *
 * The first write outside the temporary directory happens here, after every
 * check has passed. The previous version's directory is left in place: it is
 * what resolution falls back to if this adoption's pointer update does not
 * land, and removing it would make a failed update worse than a skipped one.
 */
async function adopt(
  host: Host,
  candidate: { version: string; digest: string; candidate: string; reportedVersion: string },
): Promise<Acquired> {
  const destination = path.join(managedBinRoot(host), candidate.version);
  await mkdir(destination, { recursive: true });

  const executable = path.join(destination, path.basename(candidate.candidate));
  await Bun.write(executable, Bun.file(candidate.candidate));
  await chmod(executable, 0o755);

  return {
    version: candidate.version,
    digest: candidate.digest,
    executable,
    reportedVersion: candidate.reportedVersion,
  };
}
