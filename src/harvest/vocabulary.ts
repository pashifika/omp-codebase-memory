import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { run } from "../exec.ts";

import { HarvestError } from "./transform.ts";

/**
 * The `--clients` tokens one CBM executable accepts.
 *
 * Read from the executable rather than committed here, because the vocabulary is
 * not stable across releases: v0.10.8 accepts 25 tokens and does not accept
 * `grok`, which exists in later CBM source. A pipeline that hardcodes a token
 * harvests nothing for that source, and the only reliable way to learn the set
 * is to ask.
 *
 * The executable answers by rejecting: an unknown `--clients` token makes
 * `install` print the whole vocabulary and configure nothing. That is the query,
 * and it is run with `--dry-run` and `-n` so the rejection cannot be the one
 * invocation that changes something.
 *
 * `--dry-run` is the argument, not the containment. The probe is an `install`
 * invocation like any other, so it gets the same scratch `HOME` and isolated
 * cache root `collect.ts` gives the real one: whether CBM validates the token
 * before it drains sessions and writes configuration is a detail of a release
 * nobody here controls, and running it against the operator's real `HOME` would
 * make that detail load-bearing. The refusal that guards the drain is decided
 * before this runs, in `scripts/harvest.ts`, for the same reason.
 */

/** A token no CBM release will ever accept, so the rejection is guaranteed. */
const PROBE_TOKEN = "omp-codebase-memory-vocabulary-probe";

/** A vocabulary line: two leading spaces, the token, then its display name. */
const TOKEN_LINE = /^ {2}([a-z][a-z0-9-]*) {2,}\S/u;

/**
 * Every `--clients` token `executable` accepts.
 *
 * Fails rather than returning an empty set when the probe produces no
 * vocabulary: an empty answer and "the output shape changed" are the same
 * observation from here, and treating them as "no clients available" would turn
 * a parsing failure into a silent empty harvest.
 */
export async function clientVocabulary(executable: string): Promise<ReadonlySet<string>> {
  const home = await mkdtemp(path.join(tmpdir(), "cbm-vocabulary-"));
  try {
    const probe = await run([executable, "install", "-n", "--dry-run", "--skip-binary", `--clients=${PROBE_TOKEN}`], {
      timeoutMs: 60_000,
      env: { HOME: home, CBM_CACHE_DIR: path.join(home, "cache") },
    });

    // The rejection is the expected outcome, so a *successful* exit means the
    // probe token was accepted and nothing was printed to read.
    if (probe.spawnError !== undefined) {
      throw new HarvestError(`could not read the \`--clients\` vocabulary from ${executable}: ${probe.spawnError}`);
    }

    const tokens = new Set<string>();
    for (const line of `${probe.stdout}\n${probe.stderr}`.split("\n")) {
      const match = TOKEN_LINE.exec(line);
      if (match?.[1] !== undefined) tokens.add(match[1]);
    }

    if (tokens.size === 0) {
      throw new HarvestError(
        `${executable} printed no \`--clients\` vocabulary in response to an unknown token; its output shape has ` +
          "changed and the source-client selection can no longer be verified",
      );
    }
    return tokens;
  } finally {
    // Unconditional, as in `collect`: a probe that failed must not be the reason
    // a scratch directory outlives the process that made it.
    await rm(home, { recursive: true, force: true });
  }
}
