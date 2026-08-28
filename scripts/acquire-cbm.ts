#!/usr/bin/env bun
/**
 * Downloads and adopts the newest CBM release for the harvest to run against.
 *
 * Exists for CI, where there is no OMP session to run `/cbm install` from and
 * where `curl … install.sh | bash` would be an unpinned script executed with
 * the runner's privileges. This goes through the package's own acquisition
 * instead: `releases/latest` resolved by redirect, the asset verified against
 * the release's `checksums.txt`, the archive's member list refused unless it is
 * exactly the expected four, and the candidate run once before anything depends
 * on it. Every one of those properties is one upstream's installer has, and
 * reusing them means CI exercises the path an operator's install takes.
 *
 * The newest release rather than a pinned one, deliberately. A job pinned to the
 * version the committed artifacts already claim could never notice that upstream
 * shipped different content, which is the one situation the drift gate exists
 * for.
 *
 *   bun run scripts/acquire-cbm.ts
 *
 * Writes only under this package's own root beneath `HOME`, and prints the
 * adopted executable's path. Run it against a scratch `HOME` if that matters.
 */
import { acquire } from "../src/acquire.ts";
import { processHost } from "../src/paths.ts";
import { hostTarget } from "../src/platform.ts";
import { githubReleaseSource } from "../src/release.ts";
import { updateState } from "../src/state.ts";

try {
  const host = processHost();
  const acquired = await acquire({ host, target: hostTarget(), source: githubReleaseSource() });

  // The pointer is what makes the copy resolvable: `resolveExecutable` finds a
  // managed copy through the state file rather than by scanning `bin/`.
  await updateState(host, { managedVersion: acquired.version, managedDigest: acquired.digest });

  console.log(`acquired ${acquired.reportedVersion}`);
  console.log(`  executable: ${acquired.executable}`);
  console.log(`  digest:     ${acquired.digest}`);
} catch (error) {
  console.error(`acquire: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
