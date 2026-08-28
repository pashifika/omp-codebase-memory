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
  const probe = await run([executable, "install", "-n", "--dry-run", "--skip-binary", `--clients=${PROBE_TOKEN}`], {
    timeoutMs: 60_000,
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
}

/**
 * Refuses unless every required source client is in `vocabulary`.
 *
 * `version` is named in the refusal because the token is not wrong in general,
 * only absent from this release, and that is the difference between "fix the
 * pipeline" and "harvest from a different CBM".
 */
export function requireClients(
  vocabulary: ReadonlySet<string>,
  required: readonly string[],
  version: string,
): void {
  const missing = required.filter((token) => !vocabulary.has(token));
  if (missing.length === 0) return;
  throw new HarvestError(
    `${version} does not accept \`--clients\` token(s) ${missing.map((token) => `\`${token}\``).join(", ")}; ` +
      `it accepts ${[...vocabulary].sort().join(", ")}`,
  );
}
