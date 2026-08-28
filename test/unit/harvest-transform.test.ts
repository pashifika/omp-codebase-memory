import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  AGENT_TOOLS,
  guardArtifact,
  HarvestError,
  parseDocument,
  RULE_PATH,
  scalar,
  SKILL_PATH,
  transformAgent,
  transformRule,
  transformSkill,
  type Artifact,
} from "../../src/harvest/transform.ts";

/**
 * Recorded output from `install --skip-binary --clients=claude,augment` against
 * CBM v0.10.8, laid out the way the executable emitted it.
 *
 * Committed rather than produced, so the whole transformation layer is testable
 * on a machine with no CBM executable and no network -- which is the property
 * `test/unit` is required to have.
 */
const FIXTURES = path.join(import.meta.dir, "..", "fixtures", "harvest", "cbm-0.10.8");

const fixture = async (relative: string): Promise<string> => await Bun.file(path.join(FIXTURES, relative)).text();

const AUGMENT_AGENTS = [
  "augment/agents/codebase-memory.md",
  "augment/agents/codebase-memory-scout.md",
  "augment/agents/codebase-memory-auditor.md",
] as const;

/** The body a transform must carry over untouched: everything after the source's frontmatter. */
const sourceBody = (source: string): string => parseDocument(source).body;

describe("the frontmatter scanner", () => {
  test("a document with no leading delimiter is all body", () => {
    const document = parseDocument("# Title\n\nprose\n");
    expect(document.keys).toEqual([]);
    expect(document.body).toBe("# Title\n\nprose\n");
  });

  test("an unclosed frontmatter block is refused rather than guessed at", () => {
    expect(() => parseDocument("---\nname: x\nbody with no closing delimiter\n")).toThrow(HarvestError);
  });

  test("a block sequence stays attached to the key that opened it", () => {
    const document = parseDocument("---\ntools:\n  - Read\n  - mcp__server__tool\nname: x\n---\nbody\n");
    expect(document.keys).toEqual(["tools", "name"]);
    expect(document.values.get("tools")).toContain("mcp__server__tool");
    expect(document.body).toBe("body\n");
  });
});

interface ScalarCase {
  readonly scenario: string;
  readonly frontmatter: string;
  readonly expected: string | null;
}

const scalarCases: ScalarCase[] = [
  { scenario: "a plain scalar is returned trimmed", frontmatter: "description: plain text ", expected: "plain text" },
  {
    scenario: "a double-quoted scalar is unwrapped",
    frontmatter: 'description: "Triggers on: a colon, a comma"',
    expected: "Triggers on: a colon, a comma",
  },
  {
    scenario: "an escaped quote inside a double-quoted scalar is unescaped",
    frontmatter: 'description: "he said \\"no\\""',
    expected: 'he said "no"',
  },
  {
    scenario: "a single-quoted scalar is unwrapped and its doubled quote collapsed",
    frontmatter: "description: 'it''s here'",
    expected: "it's here",
  },
  { scenario: "a key with an empty value reads as absent", frontmatter: "description:", expected: null },
  { scenario: "a key that is not present reads as absent", frontmatter: "name: x", expected: null },
];

test.each(scalarCases)("$scenario", ({ frontmatter, expected }) => {
  const document = parseDocument(`---\n${frontmatter}\n---\nbody\n`);
  expect(scalar(document, "description")).toBe(expected);
});

describe("the skill transform", () => {
  test("carries the emitted body byte-for-byte", async () => {
    const source = await fixture("claude/skills/codebase-memory/SKILL.md");
    const artifact = transformSkill(source);
    expect(parseDocument(artifact.content).body).toBe(sourceBody(source));
  });

  test("carries the emitted name and description", async () => {
    const source = await fixture("claude/skills/codebase-memory/SKILL.md");
    const document = parseDocument(transformSkill(source).content);
    expect(document.keys).toEqual(["name", "description"]);
    expect(scalar(document, "name")).toBe("codebase-memory");
    expect(scalar(document, "description")).toBe(scalar(parseDocument(source), "description"));
  });

  test("writes one level below skills/, where the provider loader stops descending", async () => {
    const source = await fixture("claude/skills/codebase-memory/SKILL.md");
    expect(transformSkill(source).path).toBe(SKILL_PATH);
  });
});

describe("the rule transform", () => {
  test("carries the emitted instructions body byte-for-byte", async () => {
    const source = await fixture("augment/rules/codebase-memory.md");
    const artifact = transformRule(source);
    expect(parseDocument(artifact.content).body).toBe(source);
  });

  test("adds the frontmatter that places the rule in the always-apply bucket", async () => {
    const source = await fixture("augment/rules/codebase-memory.md");
    const document = parseDocument(transformRule(source).content);
    expect(document.keys).toEqual(["description", "alwaysApply"]);
    expect(document.values.get("alwaysApply")?.trim()).toBe("true");
  });

  test("derives the description from the body's first prose line, past the markers and headings", async () => {
    const source = await fixture("augment/rules/codebase-memory.md");
    expect(scalar(parseDocument(transformRule(source).content), "description")).toBe(
      "This project uses codebase-memory-mcp to maintain a knowledge graph of the codebase.",
    );
  });

  test("writes the fixed rule name, so a CBM-written native rule shadows it rather than doubling it", async () => {
    const source = await fixture("augment/rules/codebase-memory.md");
    expect(transformRule(source).path).toBe(RULE_PATH);
  });

  test("refuses a source that has started carrying frontmatter of its own", () => {
    expect(() => transformRule("---\ndescription: upstream added this\n---\nbody\n")).toThrow(HarvestError);
  });

  test("refuses a source with no prose to derive a description from", () => {
    expect(() => transformRule("<!-- marker -->\n# Heading\n")).toThrow(HarvestError);
  });
});

interface AgentCase {
  readonly scenario: string;
  readonly source: string;
  readonly name: string;
}

const agentCases: AgentCase[] = [
  { scenario: "the Verify tier keeps its unsuffixed name", source: AUGMENT_AGENTS[0], name: "codebase-memory" },
  { scenario: "the Scout tier keeps its suffixed name", source: AUGMENT_AGENTS[1], name: "codebase-memory-scout" },
  { scenario: "the Auditor tier keeps its suffixed name", source: AUGMENT_AGENTS[2], name: "codebase-memory-auditor" },
];

test.each(agentCases)("$scenario", async ({ source: relative, name }) => {
  const source = await fixture(relative);
  const artifact = transformAgent(source);

  expect(artifact.path).toBe(`agents/${name}.md`);
  const document = parseDocument(artifact.content);
  expect(document.keys).toEqual(["name", "description", "tools"]);
  expect(scalar(document, "name")).toBe(name);
  expect(scalar(document, "description")).toBe(scalar(parseDocument(source), "description"));
  expect(document.values.get("tools")?.trim()).toBe(AGENT_TOOLS);
  expect(document.body).toBe(sourceBody(source));
});

interface DirectShapeCase {
  readonly scenario: string;
  readonly source: string;
}

/**
 * The direct-shape agents CBM emits for a direct-capable client.
 *
 * Each one must be refused as an agent source. They are the fixture that makes
 * "a future release turns this into a loud failure" a tested claim rather than
 * an intention: if the source client becomes direct-capable, its emitted agents
 * look exactly like these.
 */
const directShapeCases: DirectShapeCase[] = [
  { scenario: "the direct-shape Verify agent is refused as a source", source: "claude/agents/codebase-memory.md" },
  {
    scenario: "the direct-shape Scout agent is refused as a source",
    source: "claude/agents/codebase-memory-scout.md",
  },
  {
    scenario: "the direct-shape Auditor agent is refused as a source",
    source: "claude/agents/codebase-memory-auditor.md",
  },
];

test.each(directShapeCases)("$scenario", async ({ source: relative }) => {
  const source = await fixture(relative);
  expect(() => transformAgent(source)).toThrow(HarvestError);
});

interface DirectKeyCase {
  readonly scenario: string;
  readonly key: string;
  readonly line: string;
}

const directKeyCases: DirectKeyCase[] = [
  { scenario: "a source carrying `tools` is refused", key: "tools", line: "tools:\n  - Read" },
  { scenario: "a source carrying `mcpServers` is refused", key: "mcpServers", line: "mcpServers: [codebase-memory-mcp]" },
  { scenario: "a source carrying `permissionMode` is refused", key: "permissionMode", line: "permissionMode: plan" },
  { scenario: "a source carrying `skills` is refused", key: "skills", line: "skills: [codebase-memory]" },
];

test.each(directKeyCases)("$scenario", ({ key, line }) => {
  const mutated = `---\nname: codebase-memory-scout\ndescription: handoff\n${line}\n---\nbody\n`;
  expect(() => transformAgent(mutated)).toThrow(`\`${key}\``);
});

interface GuardCase {
  readonly scenario: string;
  readonly artifact: Artifact;
  /** A fragment of the refusal, so the test pins which guard fired. */
  readonly names: string;
}

const guardCases: GuardCase[] = [
  {
    scenario: "a skill with no description is refused",
    artifact: { kind: "skill", path: SKILL_PATH, content: "---\nname: codebase-memory\n---\nbody\n" },
    names: "description",
  },
  {
    scenario: "a skill nested deeper than one level below skills/ is refused",
    artifact: {
      kind: "skill",
      path: "skills/codebase/memory/SKILL.md",
      content: "---\nname: codebase-memory\ndescription: d\n---\nbody\n",
    },
    names: "one directory below",
  },
  {
    scenario: "a rule with neither alwaysApply nor a description is refused",
    artifact: { kind: "rule", path: RULE_PATH, content: "---\nglobs: '*.ts'\n---\nbody\n" },
    names: "no bucket",
  },
  {
    scenario: "a generated rule named RULES.md is refused",
    artifact: { kind: "rule", path: "rules/RULES.md", content: "---\nalwaysApply: true\n---\nbody\n" },
    names: "sticky operator rules",
  },
  {
    scenario: "an agent named after an OMP bundled agent is refused",
    artifact: {
      kind: "agent",
      path: "agents/scout.md",
      content: `---\nname: scout\ndescription: d\ntools: ${AGENT_TOOLS}\n---\nbody\n`,
    },
    names: "bundled agent",
  },
  {
    scenario: "an agent carrying a key OMP's parser does not recognise is refused",
    artifact: {
      kind: "agent",
      path: "agents/codebase-memory.md",
      content: "---\nname: codebase-memory\ndescription: d\npermissionMode: plan\n---\nbody\n",
    },
    names: "not one OMP's agent parser recognises",
  },
  {
    scenario: "a frontmatter value naming an mcp__ tool is refused",
    artifact: {
      kind: "agent",
      path: "agents/codebase-memory.md",
      content: "---\nname: codebase-memory\ndescription: d\ntools:\n  - mcp__codebase_memory_mcp_search_graph\n---\nbody\n",
    },
    names: "mcp__",
  },
];

test.each(guardCases)("$scenario", ({ artifact, names }) => {
  expect(() => guardArtifact(artifact)).toThrow(HarvestError);
  expect(() => guardArtifact(artifact)).toThrow(names);
});

test("every guard case names a distinct scenario", () => {
  const scenarios = [...guardCases, ...agentCases, ...directShapeCases, ...directKeyCases, ...scalarCases].map(
    (kase) => kase.scenario,
  );
  expect(new Set(scenarios).size).toBe(scenarios.length);
});

describe("what a generated artifact passes", () => {
  test("every artifact the pipeline produces from the fixtures survives its own guards", async () => {
    const produced: Artifact[] = [
      transformSkill(await fixture("claude/skills/codebase-memory/SKILL.md")),
      transformRule(await fixture("augment/rules/codebase-memory.md")),
      ...(await Promise.all(AUGMENT_AGENTS.map(async (relative) => transformAgent(await fixture(relative))))),
    ];

    expect(produced).toHaveLength(5);
    for (const artifact of produced) {
      expect(() => guardArtifact(artifact)).not.toThrow();
    }
  });
});
