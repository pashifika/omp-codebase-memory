/**
 * Emitted CBM output in, shipped OMP artifacts out.
 *
 * Every function here is a pure function of the text CBM's `install` wrote, so
 * the whole transformation layer is testable against recorded fixtures and a
 * contributor with no CBM executable can still run and extend the suite. The
 * driver that produces the input lives in `collect.ts`; nothing in this file
 * reads a file, starts a process, or knows what a temporary directory is.
 *
 * The guards are here rather than in the driver on purpose. A transform is the
 * only thing that produces a shipped artifact, so a guard it runs itself cannot
 * be bypassed by a second code path -- and the same guard, exported, is what a
 * unit test points at the committed tree to catch a hand edit.
 */

/** Refusal from the harvest pipeline: always names the artifact and the reason. */
export class HarvestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarvestError";
  }
}

/** Which shipped surface an artifact is, which decides the guards it faces. */
export type ArtifactKind = "skill" | "rule" | "agent";

export interface Artifact {
  readonly kind: ArtifactKind;
  /** Package-relative path with forward slashes, exactly as it is written. */
  readonly path: string;
  readonly content: string;
}

/**
 * Frontmatter as this pipeline needs to see it: which top-level keys exist, the
 * raw text of each one's value, and the body after the closing delimiter.
 *
 * Deliberately not a YAML parser. Two questions are asked of a source document
 * -- "is this key present" and "what scalar did it carry" -- and one question is
 * asked of a generated one, "does any value mention an `mcp__` name". A
 * dependency-free scanner answers all three, and this package has no runtime
 * dependencies to add one to.
 *
 * {@link Document.values} holds each key's value including continuation lines,
 * so a block sequence (`tools:` followed by `  - mcp__…`) is visible to the
 * `mcp__` guard rather than reading as an empty value.
 */
export interface Document {
  /** Top-level keys in source order. Empty when there is no frontmatter. */
  readonly keys: readonly string[];
  /** Each top-level key's raw value text, continuation lines included. */
  readonly values: ReadonlyMap<string, string>;
  /** Everything after the frontmatter, byte-for-byte. */
  readonly body: string;
}

/** A top-level frontmatter key: no indentation, a name, then a colon. */
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/u;

const DELIMITER = "---";

/**
 * Splits `text` into frontmatter and body.
 *
 * A document with no leading `---` is all body, which is the shape CBM's
 * emitted instructions file has: the rule transform supplies the frontmatter
 * that file never had.
 */
export function parseDocument(text: string): Document {
  const lines = text.split("\n");
  if (lines[0]?.trimEnd() !== DELIMITER) {
    return { keys: [], values: new Map(), body: text };
  }

  const close = lines.findIndex((line, index) => index > 0 && line.trimEnd() === DELIMITER);
  if (close === -1) {
    // An opening delimiter with no closing one is not frontmatter, and guessing
    // where it ended would silently ship half a document as a body.
    throw new HarvestError("frontmatter opened with `---` and was never closed");
  }

  const keys: string[] = [];
  const values = new Map<string, string>();
  let current: string | null = null;
  for (const line of lines.slice(1, close)) {
    const match = KEY_LINE.exec(line);
    if (match?.[1] !== undefined) {
      current = match[1];
      keys.push(current);
      values.set(current, match[2] ?? "");
      continue;
    }
    // A continuation belongs to the key above it; a stray line before any key
    // is malformed frontmatter and is dropped rather than invented into a key.
    if (current !== null) values.set(current, `${values.get(current) ?? ""}\n${line}`);
  }

  return { keys, values, body: lines.slice(close + 1).join("\n") };
}

/**
 * One frontmatter value as a scalar string, or `null` when the key is absent.
 *
 * Unwraps the quoting CBM emits -- the skill's `description` is a double-quoted
 * scalar, the agents' are plain -- so a carried value round-trips through
 * {@link quote} unchanged in meaning.
 */
export function scalar(document: Document, key: string): string | null {
  const raw = document.values.get(key);
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const first = trimmed[0];
  if ((first === '"' || first === "'") && trimmed.length > 1 && trimmed.endsWith(first)) {
    const inner = trimmed.slice(1, -1);
    return first === '"' ? inner.replace(/\\"/gu, '"').replace(/\\\\/gu, "\\") : inner.replace(/''/gu, "'");
  }
  return trimmed;
}

/**
 * A YAML double-quoted scalar.
 *
 * Every carried value goes through this rather than being emitted plain,
 * because the skill's description contains a colon followed by a space and the
 * agents' contain semicolons -- and a plain scalar that happens to parse today
 * is a wording change away from not parsing.
 */
function quote(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

/** Wraps `body` in frontmatter built from `entries`, in the order given. */
function withFrontmatter(entries: readonly (readonly [string, string])[], body: string): string {
  const front = entries.map(([key, value]) => `${key}: ${value}`).join("\n");
  return `${DELIMITER}\n${front}\n${DELIMITER}\n${body}`;
}

/**
 * The four keys CBM's direct-shape agents carry and OMP's agent contract has no
 * equivalent for.
 *
 * Their absence is what makes the source the parent-handoff variant. If a CBM
 * release makes the source client direct-capable, this list is what turns that
 * into a named failure instead of an agent whose body tells a child to call
 * tools it was never given.
 */
const DIRECT_SHAPE_KEYS = ["tools", "mcpServers", "permissionMode", "skills"] as const;

/**
 * Every frontmatter key OMP's agent parser reads.
 *
 * Both spellings of the two hyphenated fields are listed because OMP's
 * frontmatter reader normalises `thinking-level` to `thinkingLevel`, so a file
 * may legitimately carry either.
 */
const RECOGNISED_AGENT_KEYS: Readonly<Record<string, true>> = {
  name: true,
  description: true,
  tools: true,
  spawns: true,
  model: true,
  output: true,
  thinking: true,
  "thinking-level": true,
  thinkingLevel: true,
  blocking: true,
  autoloadSkills: true,
  "autoload-skills": true,
  readSummarize: true,
  "read-summarize": true,
  prewalk: true,
  advisor: true,
};

/**
 * OMP's own bundled agents.
 *
 * Agent discovery is first-wins by exact name and a package root resolves
 * before the bundled definitions, so shipping any of these names replaces one
 * of OMP's own agents with this package's -- silent, and severe for the
 * operator.
 */
const BUNDLED_AGENT_NAMES: Readonly<Record<string, true>> = {
  task: true,
  sonic: true,
  scout: true,
  designer: true,
  reviewer: true,
  "security-reviewer": true,
  librarian: true,
};

/**
 * The native tools the shipped agents declare, as a plain comma-separated
 * value.
 *
 * The shape is OMP's own bundled convention (`scout` ships
 * `tools: read, grep, glob, web_search`). The set is what the handoff body
 * actually asks for: it tells the child to verify supplied evidence against
 * exact source with read-only source tools, and nothing in it reaches the web.
 * OMP appends `yield` to any explicit list, so it is not written here.
 */
export const AGENT_TOOLS = "read, grep, glob";

/** Where each shipped surface lives, relative to the package root. */
export const SKILL_PATH = "skills/codebase-memory/SKILL.md";
export const RULE_PATH = "rules/codebase-memory.md";
export const AGENTS_DIR = "agents";

/** The rule's name, fixed so a CBM-written native rule shadows it rather than doubling it. */
export const RULE_NAME = "codebase-memory";

/**
 * The skill, carrying the emitted body verbatim.
 *
 * `name` and `description` are carried rather than written: the emitted skill
 * already has both, and OMP's plugin skill provider drops a skill with no
 * `description` instead of loading it with a default.
 */
export function transformSkill(source: string): Artifact {
  const document = parseDocument(source);
  const name = scalar(document, "name");
  const description = scalar(document, "description");
  if (name === null) {
    throw new HarvestError(`${SKILL_PATH}: the emitted skill carries no \`name\` to carry over`);
  }
  if (description === null) {
    throw new HarvestError(`${SKILL_PATH}: the emitted skill carries no \`description\` to carry over`);
  }

  const artifact: Artifact = {
    kind: "skill",
    path: SKILL_PATH,
    content: withFrontmatter(
      [
        ["name", quote(name)],
        ["description", quote(description)],
      ],
      document.body,
    ),
  };
  guardArtifact(artifact);
  return artifact;
}

/**
 * The durable rule, carrying the emitted instructions body verbatim.
 *
 * The frontmatter is load-bearing rather than decorative: a rule with no
 * `description`, no `alwaysApply`, and no trigger condition is assigned to no
 * bucket, is never injected, and is not even addressable through `rule://`.
 * `alwaysApply: true` is what makes a fresh session and a post-compaction turn
 * both carry the body, which is the behaviour CBM gets from an always-present
 * instructions file on the clients that have one.
 *
 * The description is derived from the body rather than written here, so it
 * follows the executable like everything else this pipeline ships.
 */
export function transformRule(source: string): Artifact {
  const document = parseDocument(source);
  if (document.keys.length > 0) {
    // A CBM release that starts emitting frontmatter on the instructions file
    // changes what "carry the body verbatim" means, and silently prepending a
    // second frontmatter block would produce a file with two of them.
    throw new HarvestError(
      `${RULE_PATH}: the emitted instructions file now carries frontmatter (${document.keys.join(", ")}); ` +
        "the rule transform assumes a bare body",
    );
  }

  const description = describe(source);
  if (description === null) {
    throw new HarvestError(`${RULE_PATH}: no prose line in the emitted instructions body to derive a description from`);
  }

  const artifact: Artifact = {
    kind: "rule",
    path: RULE_PATH,
    content: withFrontmatter(
      [
        ["description", quote(description)],
        ["alwaysApply", "true"],
      ],
      source,
    ),
  };
  guardArtifact(artifact);
  return artifact;
}

/**
 * The first prose sentence of an emitted instructions body.
 *
 * Skips the managed-block markers CBM wraps its section in and the headings
 * that open it, because neither describes when the rule applies.
 */
function describe(body: string): string | null {
  for (const line of body.split("\n")) {
    const text = line.trim();
    if (text === "" || text.startsWith("<!--") || text.startsWith("#")) continue;
    return text;
  }
  return null;
}

/**
 * One agent, carrying `name`, `description`, and the emitted body verbatim.
 *
 * The source must be the parent-handoff variant. Deriving from the direct
 * variant means stripping four keys, and stripping `mcpServers` and the
 * `mcp__*` tool list removes the very thing that made its body's instructions
 * true -- that body tells the child to call `search_graph` itself, which an OMP
 * subagent cannot do.
 */
export function transformAgent(source: string): Artifact {
  const document = parseDocument(source);
  for (const key of DIRECT_SHAPE_KEYS) {
    if (document.values.has(key)) {
      throw new HarvestError(
        `the emitted agent carries \`${key}\`, so it is the direct shape rather than the parent-handoff shape ` +
          "this pipeline derives from; the source client is now direct-capable and the derivation must be revisited",
      );
    }
  }

  const name = scalar(document, "name");
  const description = scalar(document, "description");
  if (name === null) throw new HarvestError("the emitted agent carries no `name`");
  if (description === null) throw new HarvestError(`agent \`${name}\` carries no \`description\``);

  const artifact: Artifact = {
    kind: "agent",
    path: `${AGENTS_DIR}/${name}.md`,
    content: withFrontmatter(
      [
        ["name", quote(name)],
        ["description", quote(description)],
        ["tools", AGENT_TOOLS],
      ],
      document.body,
    ),
  };
  guardArtifact(artifact);
  return artifact;
}

/**
 * Every guard that must fail the build, applied to a generated artifact.
 *
 * Exported and kind-dispatched so the same checks run in two places: inside
 * each transform, where they make an unshippable artifact impossible to
 * produce, and in a unit test pointed at the committed tree, where they catch a
 * hand edit that bypassed the pipeline entirely.
 */
export function guardArtifact(artifact: Artifact): void {
  const { kind, path, content } = artifact;
  const document = parseDocument(content);

  for (const key of document.keys) {
    const value = document.values.get(key) ?? "";
    if (value.includes("mcp__")) {
      throw new HarvestError(
        `${path}: frontmatter key \`${key}\` names an \`mcp__\` tool; OMP's agent contract has no field for ` +
          "attaching an MCP server, and the tier's restriction belongs in the prompt body",
      );
    }
  }

  switch (kind) {
    case "skill": {
      if (scalar(document, "description") === null) {
        throw new HarvestError(
          `${path}: a skill with no \`description\` is dropped by OMP's plugin skill provider rather than loaded`,
        );
      }
      const depth = path.split("/").length;
      if (depth !== 3 || !path.startsWith("skills/") || !path.endsWith("/SKILL.md")) {
        throw new HarvestError(
          `${path}: a skill must sit exactly one directory below \`skills/\`, because the provider loader ` +
            "does not descend further",
        );
      }
      return;
    }
    case "rule": {
      const hasAlwaysApply = document.values.get("alwaysApply")?.trim() === "true";
      if (!hasAlwaysApply && scalar(document, "description") === null) {
        throw new HarvestError(
          `${path}: a rule with neither \`alwaysApply\` nor a \`description\` lands in no bucket, is never ` +
            "injected, and is not addressable through `rule://`",
        );
      }
      const file = path.split("/").at(-1) ?? path;
      if (file === "RULES.md") {
        throw new HarvestError(
          `${path}: \`RULES.md\` is the single slot OMP reserves for sticky operator rules, and a regular rule ` +
            "file using it shadows both the user and project sticky files",
        );
      }
      return;
    }
    case "agent": {
      const name = scalar(document, "name");
      if (name === null) throw new HarvestError(`${path}: an agent with no \`name\` cannot be dispatched`);
      if (scalar(document, "description") === null) {
        throw new HarvestError(`${path}: agent \`${name}\` carries no \`description\``);
      }
      if (BUNDLED_AGENT_NAMES[name] === true) {
        throw new HarvestError(
          `${path}: \`${name}\` is an OMP bundled agent, and agent discovery is first-wins by exact name, so ` +
            "this would replace OMP's own agent with this package's",
        );
      }
      for (const key of document.keys) {
        if (RECOGNISED_AGENT_KEYS[key] !== true) {
          throw new HarvestError(`${path}: frontmatter key \`${key}\` is not one OMP's agent parser recognises`);
        }
      }
      return;
    }
  }
}
