import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  AGENT_TOOLS,
  guardArtifact,
  parseDocument,
  RULE_PATH,
  scalar,
  SKILL_PATH,
  type ArtifactKind,
} from "../../src/harvest/transform.ts";

/**
 * The committed generated tree, checked against the guards that produced it.
 *
 * The transform tests prove the pipeline cannot *emit* an unshippable artifact.
 * This file proves the tree on disk is still what the pipeline would emit's
 * shape, which is a different claim: a hand edit, a bad merge, or a partial
 * regeneration bypasses the transforms entirely and would otherwise reach an
 * operator's session unchallenged.
 *
 * The paths come from the provenance record rather than from a list written
 * here. A second list would be the hand-maintained copy this whole pipeline
 * exists to avoid, and it would pass while the record and the tree disagreed.
 */

const ROOT = path.resolve(import.meta.dir, "..", "..");

interface Provenance {
  readonly cbmVersion: string;
  readonly reportedVersion: string;
  readonly sourceClients: readonly string[];
  readonly generated: readonly string[];
}

const provenance = (await Bun.file(path.join(ROOT, "harvest.json")).json()) as Provenance;

const read = async (relative: string): Promise<string> => await Bun.file(path.join(ROOT, relative)).text();

/** Which guard set a generated path faces, decided by where it lives. */
const kindOf = (relative: string): ArtifactKind | null => {
  if (relative === SKILL_PATH) return "skill";
  if (relative.startsWith("rules/")) return "rule";
  if (relative.startsWith("agents/")) return "agent";
  return null;
};

const generatedArtifacts = provenance.generated
  .map((relative) => ({ relative, kind: kindOf(relative) }))
  .filter((entry): entry is { relative: string; kind: ArtifactKind } => entry.kind !== null);

describe("the provenance record", () => {
  test("attributes every generated artifact to one CBM version", () => {
    expect(provenance.cbmVersion).toMatch(/^\d+\.\d+\.\d+/u);
    expect(provenance.reportedVersion).toContain(provenance.cbmVersion);
    expect(provenance.sourceClients).toEqual(["claude", "augment"]);
  });

  test("names the skill, the rule, and three agents, and nothing else it does not write", () => {
    expect([...provenance.generated].sort()).toEqual([
      "agents/codebase-memory-auditor.md",
      "agents/codebase-memory-scout.md",
      "agents/codebase-memory.md",
      "harvest.json",
      RULE_PATH,
      SKILL_PATH,
    ]);
  });

  test("every path it names is on disk", async () => {
    expect(provenance.generated.length).toBeGreaterThan(0);
    for (const relative of provenance.generated) {
      expect(await Bun.file(path.join(ROOT, relative)).exists()).toBe(true);
    }
  });
});

test.each(generatedArtifacts)("the committed $relative passes every build guard", async ({ relative, kind }) => {
  const content = await read(relative);
  expect(() => guardArtifact({ kind, path: relative, content })).not.toThrow();
});

describe("the committed skill", () => {
  test("sits exactly one level under skills/ and carries both name and description", async () => {
    expect(SKILL_PATH.split("/")).toEqual(["skills", "codebase-memory", "SKILL.md"]);
    const document = parseDocument(await read(SKILL_PATH));
    expect(scalar(document, "name")).toBe("codebase-memory");
    expect(scalar(document, "description")).not.toBeNull();
  });
});

describe("the committed rule", () => {
  test("carries a description and no alwaysApply, under the fixed rule name", async () => {
    expect(RULE_PATH).toBe("rules/codebase-memory.md");
    const document = parseDocument(await read(RULE_PATH));
    expect(scalar(document, "description")).not.toBeNull();
    expect(document.values.get("alwaysApply")).toBeUndefined();
  });

  test("is the only file under rules/, so no second rule can claim the reserved name", async () => {
    const rules = provenance.generated.filter((relative) => relative.startsWith("rules/"));
    expect(rules).toEqual([RULE_PATH]);
  });
});

interface AgentCase {
  readonly scenario: string;
  readonly relative: string;
  readonly name: string;
}

const agentCases: AgentCase[] = [
  {
    scenario: "the committed Verify agent carries name, description, and the native tool CSV and nothing else",
    relative: "agents/codebase-memory.md",
    name: "codebase-memory",
  },
  {
    scenario: "the committed Scout agent carries name, description, and the native tool CSV and nothing else",
    relative: "agents/codebase-memory-scout.md",
    name: "codebase-memory-scout",
  },
  {
    scenario: "the committed Auditor agent carries name, description, and the native tool CSV and nothing else",
    relative: "agents/codebase-memory-auditor.md",
    name: "codebase-memory-auditor",
  },
];

test.each(agentCases)("$scenario", async ({ relative, name }) => {
  const document = parseDocument(await read(relative));
  expect(document.keys).toEqual(["name", "description", "tools"]);
  expect(scalar(document, "name")).toBe(name);
  expect(scalar(document, "description")).not.toBeNull();
  expect(document.values.get("tools")?.trim()).toBe(AGENT_TOOLS);
  expect(document.body.trim().length).toBeGreaterThan(0);
});
