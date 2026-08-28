import path from "node:path";

import { projectResolver } from "./project.ts";

import type { GraphClient } from "./graph.ts";
import type { ProjectResolver } from "./project.ts";
import type { ToolResultEvent, ToolResultEventResult } from "@oh-my-pi/pi-coding-agent";

/**
 * Graph context appended to a search or a read, on `tool_result`.
 *
 * `tool_result` is documented as middleware-style, is explicitly allowed to
 * replace a successful call's content, and a handler that throws there is
 * caught and reported while the run continues. `tool_call` is the inverse: a
 * throwing or blocking handler there is a refusal of the call, so a graph query
 * that stalled could deny the operator's `grep`. The asymmetry, not a
 * preference, is why only one of the two events is ever used -- and why the
 * whole body below sits inside one `try` that returns `undefined`.
 *
 * The handler appends and never replaces. `tool_result` handlers are chained and
 * each sees prior modifications, so returning anything other than the observed
 * content plus new content would discard whatever another extension
 * contributed.
 */

/** The most symbols one search may append. */
const SYMBOL_LIMIT = 12;

/** The most coverage findings one read may append. */
const COVERAGE_LIMIT = 8;

/** The most characters one appended block may hold, whatever produced it. */
const APPEND_LIMIT_BYTES = 4_096;

/** An identifier worth searching the graph for. Two characters is noise. */
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]{2,}/gu;

/** The most identifiers taken from one pattern, so a long regex cannot become a long query. */
const QUERY_TOKEN_LIMIT = 4;

/** The coverage status meaning "the index recorded no problem with this path". */
const CLEAN_COVERAGE = "no_recorded_issue";

/**
 * The caveat the appended coverage text must carry.
 *
 * CBM supplies its own wording in the response and it is preferred; this is the
 * fallback, because the statement is required whether or not upstream keeps
 * sending it.
 */
const COVERAGE_CAVEAT =
  "A clean coverage result means no recorded gap, not proof of completeness.";

export interface AugmentDeps {
  /**
   * Opens the graph client, or answers `null` when no executable resolves.
   *
   * Called at most once, on the first augmentation. A session that never
   * searches never starts a CBM process.
   */
  readonly openClient: () => Promise<GraphClient | null>;
  /** The session's working directory, which decides the project. */
  readonly cwd: string;
  /**
   * Shows a message to the operator.
   *
   * Called at most once per distinct message: the repetition guard lives in the
   * augmenter rather than in the sink, because "at most one notice per session"
   * is a property of this component and belongs where it can be tested.
   */
  readonly notify: (message: string) => void;
  /** Records a failure. Nothing here reaches the operator. */
  readonly debug: (message: string) => void;
}

/** The `tool_result` handler, and the client it holds for the session. */
export interface Augmenter {
  handle(event: ToolResultEvent): Promise<ToolResultEventResult | undefined>;
  /** Releases the graph client. Safe before the first augmentation. */
  close(): void;
}

/**
 * Builds the handler.
 *
 * The client and the project resolution are memoised across the session: the
 * working directory does not move in a way that would change the project, and
 * re-deriving a constant per `grep` is the cost the query deadline exists to
 * bound.
 */
export function createAugmenter(deps: AugmentDeps): Augmenter {
  let opened: Promise<{ client: GraphClient; resolver: ProjectResolver } | null> | null = null;
  let client: GraphClient | null = null;

  /** Messages already shown, so a persistent cause is reported once and not per call. */
  const notified = new Set<string>();

  const notifyOnce = (message: string): void => {
    if (notified.has(message)) return;
    notified.add(message);
    deps.notify(message);
  };

  const session = async (): Promise<{ client: GraphClient; resolver: ProjectResolver } | null> => {
    opened ??= (async () => {
      const opening = await deps.openClient();
      if (opening === null) return null;
      client = opening;
      return { client: opening, resolver: projectResolver(opening, deps.cwd) };
    })();
    return await opened;
  };

  return {
    async handle(event) {
      try {
        // An errored result is left alone: the model needs to see the failure,
        // and graph context under it would read as though something worked.
        if (event.isError) return undefined;
        if (event.toolName !== "grep" && event.toolName !== "glob" && event.toolName !== "read") return undefined;

        const active = await session();
        // No executable resolved. Silent by construction: this is not a
        // failure the operator asked about, and the lifecycle command already
        // reports it on demand.
        if (active === null) return undefined;

        const resolution = await active.resolver.resolve();
        if (resolution.kind === "unavailable") return undefined;
        if (resolution.kind === "unindexed") {
          notifyOnce(
            "codebase-memory-mcp: no indexed project covers this directory, so graph context is not being added. " +
              "Ask the agent to index it, or run /cbm status to see the resolution.",
          );
          return undefined;
        }

        const appended =
          event.toolName === "read"
            ? await coverageFor(active.client, resolution.project.name, resolution.project.root, event.input, deps.cwd)
            : await symbolsFor(active.client, resolution.project.name, event.toolName, event.input);
        if (appended === null) return undefined;

        return {
          // Every chunk the tool produced, unchanged, then one more. Spread
          // rather than mutated: the event's array belongs to the caller.
          content: [...event.content, { type: "text", text: appended.slice(0, APPEND_LIMIT_BYTES) }],
        };
      } catch (error) {
        // The whole body, so nothing this package does can change what a tool
        // returned. OMP would catch and report a throw here; failing open means
        // it never has to.
        deps.debug(`augmentation failed: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    },

    close() {
      client?.close();
      client = null;
    },
  };
}

/**
 * Graph symbols matching a search, or `null` when there is nothing to add.
 *
 * `grep` searches by identifier, so its pattern becomes a keyword query --
 * CBM's own full-text search splits camelCase into words, which is what makes a
 * pattern written for a regex engine usable as one. `glob` names files rather
 * than symbols, so its pattern becomes a file filter and the answer is the
 * symbols those files define.
 */
async function symbolsFor(
  client: GraphClient,
  project: string,
  tool: "grep" | "glob",
  input: Readonly<Record<string, unknown>>,
): Promise<string | null> {
  const selector = tool === "grep" ? queryFrom(input["pattern"]) : filePatternFrom(input["path"]);
  if (selector === null) return null;

  const structured = await client.call("search_graph", {
    project,
    ...selector,
    limit: SYMBOL_LIMIT,
    format: "json",
  });

  const rows = readRows(structured);
  if (rows === null || rows.length === 0) return null;

  const lines = rows.slice(0, SYMBOL_LIMIT).map((row) => `- ${row.qualified} (${row.label}) ${row.file}${row.lines}`);
  return [
    `Codebase graph — ${lines.length} symbol(s) matching this ${tool} in project ${project}:`,
    ...lines,
    "Use trace_path or get_code_snippet on a qualified name for callers or exact source.",
  ].join("\n");
}

/**
 * A keyword query built from a grep pattern, or `null` when it holds no
 * identifier.
 *
 * Regex metacharacters are simply not identifier characters, so extracting
 * identifiers discards them without needing to understand the pattern.
 */
function queryFrom(pattern: unknown): { readonly query: string } | null {
  if (typeof pattern !== "string") return null;
  const tokens = [...pattern.matchAll(IDENTIFIER)].map((match) => match[0]).slice(0, QUERY_TOKEN_LIMIT);
  return tokens.length === 0 ? null : { query: tokens.join(" ") };
}

/**
 * A file-path regex built from a glob, or `null` when there is no path to
 * filter on.
 *
 * Three constructs are translated and everything else is escaped, so a pattern
 * this function does not understand narrows the search rather than widening it.
 * `**` + separator becomes an optional run of directories rather than a
 * mandatory one, because `src/**` + `/*.ts` must still match `src/a.ts` -- the
 * mistake that makes a globstar quietly skip the top level.
 */
function filePatternFrom(value: unknown): { readonly file_pattern: string } | null {
  if (typeof value !== "string") return null;
  // A semicolon-delimited list is several searches; the first is the one this
  // single query can answer for.
  const glob = value.split(";")[0]?.trim() ?? "";
  if (glob === "" || glob === ".") return null;

  const translated = glob
    .split("**/")
    .map((run) =>
      run
        .split("**")
        .map((part) => part.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("*", "[^/]*").replaceAll("?", "."))
        .join(".*"),
    )
    .join("(?:.*/)?");
  return { file_pattern: translated };
}

/** One graph row, flattened out of the grouped response `search_graph` returns. */
interface SymbolRow {
  readonly qualified: string;
  readonly label: string;
  readonly file: string;
  readonly lines: string;
}

/**
 * The rows of a `search_graph` JSON response.
 *
 * The response is grouped by qualified-name prefix with column-ordered row
 * arrays, so the columns are read by the names the response itself declares
 * rather than by position -- a reordered `cols` would otherwise silently swap
 * two fields.
 */
function readRows(structured: unknown): readonly SymbolRow[] | null {
  if (typeof structured !== "object" || structured === null) return null;
  if (!("cols" in structured) || !("groups" in structured)) return null;
  const { cols, groups } = structured;
  if (!Array.isArray(cols) || !Array.isArray(groups)) return null;

  const nameAt = cols.indexOf("name");
  const labelAt = cols.indexOf("label");
  const linesAt = cols.indexOf("lines");
  if (nameAt === -1) return null;

  const rows: SymbolRow[] = [];
  for (const group of groups as readonly unknown[]) {
    if (typeof group !== "object" || group === null) continue;
    if (!("qn_prefix" in group) || !("rows" in group)) continue;
    const prefix = group.qn_prefix;
    const file = "file" in group && typeof group.file === "string" ? group.file : "";
    if (typeof prefix !== "string" || !Array.isArray(group.rows)) continue;

    for (const row of group.rows as readonly unknown[]) {
      if (!Array.isArray(row)) continue;
      const name = row[nameAt];
      if (typeof name !== "string" || name === "__file__") continue;
      const label = labelAt === -1 ? "" : row[labelAt];
      const lines = linesAt === -1 ? "" : row[linesAt];
      rows.push({
        qualified: `${prefix}.${name}`,
        label: typeof label === "string" && label !== "" ? label : "symbol",
        file,
        lines: typeof lines === "string" && lines !== "" ? `:${lines}` : "",
      });
      if (rows.length >= SYMBOL_LIMIT) return rows;
    }
  }
  return rows;
}

/**
 * Coverage findings for a read path, or `null` when the index recorded none.
 *
 * Nothing is appended for a clean result. Appending coverage text to every read
 * would train the model to ignore it, and the one case worth interrupting for is
 * a file the graph parsed only partially being trusted as complete.
 */
async function coverageFor(
  client: GraphClient,
  project: string,
  root: string,
  input: Readonly<Record<string, unknown>>,
  cwd: string,
): Promise<string | null> {
  const target = input["path"];
  if (typeof target !== "string" || target === "") return null;
  // An internal URL or a remote target is not a path in the graph.
  if (target.includes("://")) return null;

  // Project-relative, because that is how the index records a path. A target
  // outside the project root has no coverage to report.
  const relative = path.relative(root, path.resolve(cwd, target.split(":")[0] ?? target));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;

  const structured = await client.call("check_index_coverage", { project, paths: [relative] });
  if (typeof structured !== "object" || structured === null || !("paths" in structured)) return null;
  const reported = structured.paths;
  if (!Array.isArray(reported)) return null;

  const findings: string[] = [];
  for (const entry of reported as readonly unknown[]) {
    if (typeof entry !== "object" || entry === null || !("status" in entry)) continue;
    const status = entry.status;
    if (typeof status !== "string" || status === CLEAN_COVERAGE) continue;

    const action = "recommended_action" in entry && typeof entry.recommended_action === "string"
      ? entry.recommended_action
      : "";
    findings.push(`- ${relative}: ${status}${action === "" ? "" : ` (${action})`}`);
    if (!("coverage" in entry) || !Array.isArray(entry.coverage)) continue;
    for (const gap of (entry.coverage as readonly unknown[]).slice(0, COVERAGE_LIMIT)) {
      if (typeof gap !== "object" || gap === null) continue;
      const where = "path" in gap && typeof gap.path === "string" ? gap.path : relative;
      const kind = "kind" in gap && typeof gap.kind === "string" ? gap.kind : "unknown";
      const detail = "detail" in gap && typeof gap.detail === "string" ? gap.detail : "";
      findings.push(`  - ${where}: ${kind}${detail === "" ? "" : ` — ${detail}`}`);
    }
  }
  if (findings.length === 0) return null;

  const caveat =
    "caveat" in structured && typeof structured.caveat === "string" && structured.caveat !== ""
      ? structured.caveat
      : COVERAGE_CAVEAT;
  return [`Codebase graph coverage for this read (project ${project}):`, ...findings, caveat].join("\n");
}
