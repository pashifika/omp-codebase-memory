import skillText from "../skills/codebase-memory/SKILL.md" with { type: "text" };

import type { GraphClient } from "./graph.ts";

/**
 * Whether the executable still has the tools the shipped guidance names.
 *
 * Without this, an upstream rename degrades the shipped skill, rule, and agents
 * into instructions naming tools that no longer exist -- and nothing
 * distinguishes that from a graph that simply found nothing. The check runs on
 * the operator's own machine against the executable they actually have, which is
 * why it is the primary drift detector and the scheduled CI job is the
 * secondary one: it is unaffected by anything GitHub does to a dormant
 * repository's schedule.
 *
 * The names come from the shipped skill, embedded at build time. A second list
 * written here would be the hand-maintained copy the harvest pipeline exists to
 * avoid, and it would agree with the executable while disagreeing with what the
 * model was actually told.
 */

/**
 * The heading that opens the skill's canonical tool enumeration.
 *
 * Matched loosely on purpose: CBM writes the count into the heading
 * (`## 15 MCP Tools`), so pinning the text would break on the next tool.
 */
const TOOL_SECTION = /^#{1,6}\s+.*\bMCP Tools\b/u;

/** A bare backticked identifier, which is how the enumeration writes each name. */
const BACKTICKED = /`([a-z][a-z0-9_]*)`/gu;

/**
 * The tool names the shipped skill enumerates, or `null` when the enumeration
 * could not be found.
 *
 * Read from the enumeration section rather than from every backtick in the
 * tree, because the prose elsewhere backticks response fields (`has_more`) and
 * another harness's own tool (`delegate_task`) in the same style. Those are not
 * CBM tools, and reporting them as missing would make the notice noise.
 *
 * `null` rather than an empty list when the section is gone, so a caller can
 * tell "nothing to compare" from "everything matched". A unit test over the
 * committed artifacts turns that state into a build failure rather than a check
 * that has quietly stopped checking.
 */
export function referencedTools(skill: string = skillText): readonly string[] | null {
  const lines = skill.split("\n");
  const opening = lines.findIndex((line) => TOOL_SECTION.test(line));
  if (opening === -1) return null;

  const names = new Set<string>();
  for (const line of lines.slice(opening + 1)) {
    const text = line.trim();
    // The enumeration ends at the first blank line after it, or at the next
    // heading when it is empty.
    if (text === "") {
      if (names.size > 0) break;
      continue;
    }
    if (text.startsWith("#")) break;
    for (const match of text.matchAll(BACKTICKED)) {
      if (match[1] !== undefined) names.add(match[1]);
    }
  }
  return names.size === 0 ? null : [...names];
}

/**
 * The enumerated names `available` no longer has.
 *
 * `null` when the shipped enumeration could not be read, which is a fact about
 * this package rather than about the executable and must not be reported as
 * upstream drift.
 */
export function driftedTools(available: readonly string[], skill: string = skillText): readonly string[] | null {
  const referenced = referencedTools(skill);
  if (referenced === null) return null;
  const present = new Set(available);
  return referenced.filter((name) => !present.has(name));
}

export interface ToolSurfaceOptions {
  /** Where a failure is recorded. Nothing here reaches the operator. */
  readonly onDebug?: (message: string) => void;
}

/**
 * The one notice a changed tool surface earns, or `null` when there is nothing
 * to say.
 *
 * `null` covers three different silences, and each is deliberate: the tool list
 * could not be obtained (recorded in the debug log only, because a failed query
 * is not something the operator asked for), the shipped enumeration could not be
 * read (a packaging fault, caught by the suite rather than shown mid-session),
 * and every referenced name is present.
 */
export async function checkToolSurface(
  client: GraphClient,
  version: string,
  options: ToolSurfaceOptions = {},
): Promise<string | null> {
  const debug = options.onDebug ?? ((): void => {});

  const available = await client.toolNames();
  if (available === null) {
    debug("tool-surface check: the executable's tool list could not be obtained");
    return null;
  }

  const missing = driftedTools(available);
  if (missing === null) {
    debug("tool-surface check: the shipped skill no longer carries a readable tool enumeration");
    return null;
  }
  if (missing.length === 0) return null;

  return (
    `${version} no longer exposes ${missing.join(", ")}, which this package's shipped guidance still names. ` +
    "Update omp-codebase-memory, or expect the graph instructions to reference tools that are not there."
  );
}
