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

/**
 * Node labels that name a container rather than a definition.
 *
 * `name_pattern` matches these like any other node, and the keyword mode this
 * replaced filtered them upstream. A Module or a Folder is not something the
 * operator's search found, and its degree is file-level rather than symbol-level.
 */
const CONTAINER_LABELS = new Set(["File", "Folder", "Module"]);

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
  /**
   * Opens the graph session and resolves the project ahead of the first search.
   *
   * Called from a deferred timer at session start, and never awaited by a tool
   * result. Without it the first search in every session would append nothing:
   * a query refuses to wait for the handshake, and the handshake is the one slow
   * step -- ~2.9 s against a warm CBM daemon, ~9 s when the daemon has to start.
   * Paying that in the background is what makes the first `grep` useful instead
   * of merely fast.
   */
  warm(): Promise<void>;
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

    async warm() {
      const started = Date.now();
      try {
        const active = await session();
        if (active === null) return;
        // `toolNames` is the one call that waits for the handshake, so it is
        // what turns "started" into "ready"; the project resolution then runs
        // on a session a search will find warm.
        const ready = (await active.client.toolNames()) !== null;
        const resolution = await active.resolver.resolve();
        // Recorded because the warm-up is a race against the first search and
        // its outcome is otherwise invisible: a session whose searches append
        // nothing needs one line saying whether the session was ready and which
        // project it resolved.
        deps.debug(
          `warm-up ${ready ? "ready" : "incomplete"} in ${Date.now() - started}ms, project ${resolution.kind}`,
        );
      } catch (error) {
        deps.debug(`warm-up failed: ${error instanceof Error ? error.message : String(error)}`);
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
 * Both tools search by name, so both use `name_pattern`. `grep` supplies the
 * identifiers its pattern holds; `glob` supplies a path filter and the answer is
 * the symbols those files define.
 *
 * The keyword mode this used first is deliberately abandoned. Measured against
 * v0.10.8, `query: "resolve"` answers 14 rows including `managedCopy`,
 * `pathOption`, `OrderCase`, and `Layout` -- symbols whose names hold no
 * `resolve` at all, surfaced because BM25 indexes docstrings and file names. A
 * block headed "symbols matching this grep" listing rows the grep did not match
 * is wrong, and the same query answers flat with a `rank` column in place of
 * `in`/`out`, so it cannot carry degree either. `name_pattern: "(resolve)"`
 * answers the 11 rows whose names actually contain it, with degree.
 */
async function symbolsFor(
  client: GraphClient,
  project: string,
  tool: "grep" | "glob",
  input: Readonly<Record<string, unknown>>,
): Promise<string | null> {
  const selector = tool === "grep" ? namePatternFrom(input["pattern"]) : filePatternFrom(input["path"]);
  if (selector === null) return null;

  const structured = await client.call("search_graph", {
    project,
    ...selector,
    limit: SYMBOL_LIMIT,
    format: "json",
  });

  const rows = readRows(structured);
  if (rows === null || rows.length === 0) return null;

  // Highest in-degree first: `name_pattern` does not rank, and when the bound
  // truncates, the symbols most depended on are the ones worth the slots.
  const ranked = [...rows].sort((left, right) => right.inDegree - left.inDegree).slice(0, SYMBOL_LIMIT);
  const lines = ranked.map((row) => `- ${row.qualified} (${row.label}) ${row.file}${row.lines}${degreeOf(row)}`);
  const carriesDegree = ranked.some((row) => row.inDegree >= 0);
  return [
    `Codebase graph — ${lines.length} symbol(s) matching this ${tool} in project ${project}:`,
    ...lines,
    carriesDegree
      ? "in/out is selected graph degree, not a caller count; use trace_path for callers or get_code_snippet for source."
      : "Use trace_path for callers or get_code_snippet for exact source.",
  ].join("\n");
}

/** The degree suffix for a row, or `""` when the response carried no degree columns. */
function degreeOf(row: SymbolRow): string {
  return row.inDegree < 0 ? "" : ` — ${row.inDegree} in / ${row.outDegree} out`;
}

/**
 * A `name_pattern` built from a grep pattern, or `null` when it holds no
 * identifier.
 *
 * Regex metacharacters are simply not identifier characters, so extracting
 * identifiers discards them without needing to understand the pattern. The
 * result is left unanchored, which makes it a substring match on symbol names --
 * the same thing the operator's `grep` did to lines.
 *
 * The identifiers need no escaping: {@link IDENTIFIER} admits only characters
 * that are literals in a regex.
 */
function namePatternFrom(pattern: unknown): { readonly name_pattern: string } | null {
  if (typeof pattern !== "string") return null;
  const tokens = [...new Set([...pattern.matchAll(IDENTIFIER)].map((match) => match[0]))].slice(0, QUERY_TOKEN_LIMIT);
  return tokens.length === 0 ? null : { name_pattern: `(${tokens.join("|")})` };
}

/**
 * A `file_pattern` built from a glob, or `null` when there is no path to filter
 * on.
 *
 * `file_pattern` is a LIKE match, not a regex. Measured against v0.10.8: `src`
 * matches 276 nodes, `src/.*` matches none, and `src/*` matches 275 -- so `.` is
 * a literal there while `*` behaves as `%`. The glob is therefore translated to
 * LIKE wildcards and consecutive ones collapsed, which is also what makes a
 * globstar behave: `src/**` + `/*.ts` becomes `src/%.ts` and matches both
 * `src/resolve.ts` and `src/harvest/collect.ts`.
 *
 * A pattern that reduces to a bare `%` is refused: it selects the whole project,
 * which is not an answer to any search.
 */
function filePatternFrom(value: unknown): { readonly file_pattern: string } | null {
  if (typeof value !== "string") return null;
  // A semicolon-delimited list is several searches; the first is the one this
  // single query can answer for.
  const glob = value.split(";")[0]?.trim() ?? "";
  if (glob === "" || glob === ".") return null;

  const like = glob
    .replaceAll("?", "_")
    .replace(/\*+\/?/gu, "%")
    .replace(/%+/gu, "%");
  return like === "%" ? null : { file_pattern: like };
}

/**
 * One graph row, flattened out of whichever response shape produced it.
 *
 * `inDegree`/`outDegree` are `-1` when the response carried no degree columns.
 * They are the graph's selected degree over CALLS, USAGE, CALL_REFERENCE,
 * INHERITS, and IMPLEMENTS -- not a caller count, which is what `trace_path`
 * answers -- and the appended text says so.
 */
interface SymbolRow {
  readonly qualified: string;
  readonly label: string;
  readonly file: string;
  readonly lines: string;
  readonly inDegree: number;
  readonly outDegree: number;
}

/** Where each field sits in a response's column-ordered rows. `-1` means absent. */
interface Columns {
  readonly qn: number;
  readonly name: number;
  readonly label: number;
  readonly file: number;
  readonly lines: number;
  readonly in: number;
  readonly out: number;
}

/**
 * The rows of a `search_graph` JSON response, in either shape it answers with.
 *
 * Both selectors this package sends answer grouped: `groups` each carrying a
 * `qn_prefix` and a `file`, with rows whose columns are
 * `name, label, lines, in, out`. The flat shape -- one `rows` list whose columns
 * are `qn, label, file, lines, rank` -- is what the keyword mode answers, and is
 * still read because a release that changes which mode answers which shape must
 * degrade to a row without degree rather than to silence. Reading only the
 * grouped shape once silently returned nothing for every `grep`.
 *
 * Columns are read by the names the response itself declares rather than by
 * position, so a reordered `cols` cannot silently swap two fields.
 */
function readRows(structured: unknown): readonly SymbolRow[] | null {
  if (typeof structured !== "object" || structured === null || !("cols" in structured)) return null;
  const declared = structured.cols;
  if (!Array.isArray(declared)) return null;

  const at = (key: string): number => declared.indexOf(key);
  const columns: Columns = {
    qn: at("qn"),
    name: at("name"),
    label: at("label"),
    file: at("file"),
    lines: at("lines"),
    in: at("in"),
    out: at("out"),
  };
  if (columns.qn === -1 && columns.name === -1) return null;

  const rows: SymbolRow[] = [];
  if ("rows" in structured && Array.isArray(structured.rows)) {
    collect(rows, structured.rows, columns, "", "");
    return rows;
  }
  if ("groups" in structured && Array.isArray(structured.groups)) {
    for (const group of structured.groups as readonly unknown[]) {
      if (rows.length >= SYMBOL_LIMIT) break;
      if (typeof group !== "object" || group === null || !("rows" in group)) continue;
      if (!Array.isArray(group.rows)) continue;
      const prefix = "qn_prefix" in group && typeof group.qn_prefix === "string" ? group.qn_prefix : "";
      const file = "file" in group && typeof group.file === "string" ? group.file : "";
      collect(rows, group.rows, columns, prefix, file);
    }
    return rows;
  }
  return null;
}

/**
 * Appends one row list to `out`, bounded by {@link SYMBOL_LIMIT}.
 *
 * `prefix` and `groupFile` supply what a grouped response keeps on the group
 * rather than on the row; a flat response passes neither and carries both in its
 * own columns.
 *
 * Container nodes are dropped. `name_pattern` matches them like anything else --
 * searching `resolve` answers with the `resolve` Module and the `resolve.ts`
 * File beside the three real symbols -- and a file or folder is not a definition
 * the operator's search found. The keyword mode filtered these upstream; this
 * mode does not, so the filter lives here.
 */
function collect(
  out: SymbolRow[],
  rows: readonly unknown[],
  columns: Columns,
  prefix: string,
  groupFile: string,
): void {
  for (const row of rows) {
    if (out.length >= SYMBOL_LIMIT) return;
    if (!Array.isArray(row)) continue;

    const cell = (index: number): string => {
      if (index < 0) return "";
      const value: unknown = row[index];
      return typeof value === "string" ? value : "";
    };
    const count = (index: number): number => {
      if (index < 0) return -1;
      const value: unknown = row[index];
      return typeof value === "number" && Number.isFinite(value) ? value : -1;
    };

    const bare = cell(columns.name);
    const qualified = columns.qn >= 0 ? cell(columns.qn) : prefix === "" ? bare : `${prefix}.${bare}`;
    if (qualified === "" || qualified.endsWith("__file__")) continue;

    const label = cell(columns.label) === "" ? "symbol" : cell(columns.label);
    if (CONTAINER_LABELS.has(label)) continue;

    const lines = cell(columns.lines);
    out.push({
      qualified,
      label,
      file: cell(columns.file) === "" ? groupFile : cell(columns.file),
      lines: lines === "" ? "" : `:${lines}`,
      inDegree: count(columns.in),
      outDegree: count(columns.out),
    });
  }
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
