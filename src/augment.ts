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

/**
 * The most rows one search asks the graph for.
 *
 * Larger than {@link SYMBOL_LIMIT} on purpose, and this is what makes the
 * ranking below mean anything. `name_pattern` does not rank, so asking for
 * exactly the append bound hands the choice of survivors to the server, in its
 * own `qn_prefix` order, and the local sort then only re-orders a page it did
 * not choose. Measured against v0.10.8: `name_pattern: "(read)"` with
 * `limit: 12` answers `total: 19, has_more: true` and omits `readState`, whose
 * in-degree of 15 is the highest of the nineteen, while spending two of the
 * twelve slots on a `Module` and a `File` the label filter then drops. The same
 * query with `limit: 50` answers all nineteen with `has_more: false`.
 *
 * 50 is CBM's own default page size, so this asks for the page it would have
 * produced anyway: one query, one bounded response, and an in-degree ranking
 * over the matches rather than over a page.
 */
const CANDIDATE_LIMIT = 50;

/** The most coverage findings one read may append. */
const COVERAGE_LIMIT = 8;

/** The most bytes one appended block may hold, whatever produced it. */
const APPEND_LIMIT_BYTES = 4_096;

/**
 * The most bytes the heading may hold, and separately the closing note.
 *
 * An eighth of {@link APPEND_LIMIT_BYTES} each, so the rows are guaranteed
 * three quarters of the block no matter what the frame carries. Both positions
 * interpolate a string the *server* chose -- the heading carries
 * `list_projects`' project name, the note carries `check_index_coverage`'s own
 * caveat -- and neither used to be bounded at all. Measured against the real
 * `createAugmenter` with a recording client: a 9,000-byte `caveat` produced a
 * 9,053-byte append holding the heading, the caveat, and ZERO coverage findings,
 * because the frame had exhausted the budget before the first row was weighed;
 * a 9,000-byte project name produced a 9,174-byte append whose heading claimed
 * `1 symbol(s)` and listed none.
 *
 * 512 bytes is three times the longest string either side actually produces:
 * measured, 162 bytes for the widest heading this package builds, 111 for its
 * longest note, and 167 for the caveat CBM v0.10.8 sends. Nothing real is cut.
 * A frame that does not fit is cut rather than allowed to displace the rows,
 * because the rows are what the block is for: a heading claiming `1 symbol(s)`
 * above an empty list is a false statement, and a coverage block with no finding
 * row drops the reported reason `graph-augmentation "Scenario: Read of a
 * partially covered file"` requires. A cut caveat still reads as a caveat.
 */
const FRAME_LIMIT_BYTES = 512;

/** Weighs an appended block in bytes rather than in UTF-16 code units. */
const ENCODER = new TextEncoder();

/** Marks a frame the bound cut, so the cut does not read as the server's own wording. */
const CUT_MARK = "…";

/** {@link CUT_MARK}'s own cost, which the room left for a cut frame has to allow for. */
const CUT_MARK_BYTES = ENCODER.encode(CUT_MARK).length;

/** An identifier worth searching the graph for. Two characters is noise. */
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]{2,}/gu;

/** The most identifiers taken from one pattern, so a long regex cannot become a long query. */
const QUERY_TOKEN_LIMIT = 4;

/**
 * Node labels that name a definition, and the only ones an append may carry.
 *
 * An allow-list rather than a list of containers to exclude, because the two
 * failure directions are not symmetric: a label this package has not seen costs
 * one absent row if it turns out to be a definition, and a false claim if it is
 * not. Excluding `File`/`Folder`/`Module` let three more through on this project
 * alone -- measured, `name_pattern: "(graph)"` answers 19 rows of which 7 are
 * `Section` (markdown headings) and one is `Branch`, whose group carries no file
 * so the row prints an empty path -- under a heading claiming they matched the
 * operator's search, which `graph-augmentation "Container nodes SHALL be
 * excluded"` forbids.
 *
 * The list is not guesswork. v0.10.8 holds one set of labels it treats as
 * symbols, and repeats it verbatim in four SQL statements -- the `trace_path`
 * candidate lookup, the qualified-name enumeration, the vector search, and the
 * BM25 structural boost:
 *
 *     label IN ('Function','Method','Class','Struct','Interface','Enum','Type','Trait')
 *
 * That is what makes `Struct`, `Enum`, and `Trait` belong here even though this
 * TypeScript repository's own index holds none of them: an operator searching a
 * Go or Rust project would otherwise get an empty append for every hit.
 *
 * `Variable` is the one addition to that set. CBM leaves it out because its
 * keyword mode filters `File`/`Folder`/`Module`/`Variable` as noise, which is a
 * judgement about relevance over docstrings; a variable whose *name* the grep
 * matched is a definition the search found, and `EXECUTABLE_NAME` and
 * `CHECK_INTERVAL_MS` are rows worth having.
 *
 * `Route` is the one deliberate omission from it. CBM boosts routes above
 * classes in its keyword ranking, so this is a real trade rather than an
 * oversight -- but a route is not what an identifier from a `grep` pattern
 * matches, and all 11 in this index are synthesised path strings such as
 * `__route__ANY__/work/app/src` with no file, no line range and zero degree, so
 * the row would be three empty columns. If a release starts emitting locatable
 * routes, adding the label is a one-line change with a measurement behind it.
 */
const DEFINITION_LABELS: Record<string, true> = {
  Class: true,
  Enum: true,
  Function: true,
  Interface: true,
  Method: true,
  Struct: true,
  Trait: true,
  Type: true,
  Variable: true,
};

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
   * searches never starts a CBM process. A rejection counts as `null` and is
   * not re-raised per tool result: this is the inverse of the pitfall
   * `src/project.ts:90-98` documents, because what would be memoised here is a
   * rejected promise rather than a non-answer.
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
  /** Whether `close()` has been called, which an in-flight open must observe. */
  let closed = false;

  /** Messages already shown, so a persistent cause is reported once and not per call. */
  const notified = new Set<string>();

  const notifyOnce = (message: string): void => {
    if (notified.has(message)) return;
    notified.add(message);
    deps.notify(message);
  };

  const session = async (): Promise<{ client: GraphClient; resolver: ProjectResolver } | null> => {
    opened ??= (async () => {
      try {
        const opening = await deps.openClient();
        if (opening === null) return null;
        // `close()` can arrive while the open is in flight -- `session_shutdown`
        // during the warm-up is exactly that. Without this the client is stored
        // where nothing will ever release it, `warm()` goes on to hand shake
        // with it, and the CBM process outlives the session that started it.
        if (closed) {
          opening.close();
          return null;
        }
        client = opening;
        return { client: opening, resolver: projectResolver(opening, deps.cwd) };
      } catch (error) {
        deps.debug(`opening the graph session failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
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
          // rather than mutated: the event's array belongs to the caller. The
          // block is already bounded by `block()`, which cuts between rows.
          content: [...event.content, { type: "text", text: appended }],
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
      closed = true;
      client?.close();
      client = null;
    },
  };
}

/**
 * Graph symbols matching a search, or `null` when there is nothing to add.
 *
 * Both tools search by name, so both use `name_pattern`. `grep` supplies the
 * identifiers its pattern holds and the path it was scoped to; `glob` supplies
 * a path filter and the answer is the symbols those files define. The graph is
 * asked for {@link CANDIDATE_LIMIT} rows and the best {@link SYMBOL_LIMIT} of
 * them are appended, so the ranking is this package's rather than the
 * response's ordering.
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
  const selector = selectorFor(tool, input);
  if (selector === null) return null;

  const structured = await client.call("search_graph", {
    project,
    ...selector,
    limit: CANDIDATE_LIMIT,
    format: "json",
  });

  const rows = readRows(structured);
  if (rows === null || rows.length === 0) return null;

  // Highest in-degree first: `name_pattern` does not rank, and when the bound
  // truncates, the symbols most depended on are the ones worth the slots.
  const ranked = [...rows].sort((left, right) => right.inDegree - left.inDegree).slice(0, SYMBOL_LIMIT);
  const lines = ranked.map((row) => `- ${row.qualified} (${row.label}) ${row.file}${row.lines}${degreeOf(row)}`);
  const carriesDegree = ranked.some((row) => row.inDegree >= 0);
  return block(
    (listed) => symbolHeading(tool, project, listed, rows.length, structured),
    lines,
    carriesDegree
      ? "in/out is selected graph degree, not a caller count; use trace_path for callers or get_code_snippet for source."
      : "Use trace_path for callers or get_code_snippet for exact source.",
  );
}

/**
 * The `search_graph` selector for one tool call, or `null` when the call holds
 * no question the graph can answer.
 *
 * A `grep` selects by the identifiers its pattern holds, narrowed by the tool's
 * own `path` scope when it has one: a row from a file the grep never searched
 * is not a symbol "matching this grep", which is what the appended heading
 * claims. The scope reader already handles the same semicolon-delimited list
 * syntax the tool takes. A `glob` has only the path.
 */
function selectorFor(
  tool: "grep" | "glob",
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> | null {
  const scope = filePatternFrom(input["path"]);
  if (tool === "glob") return scope;

  const named = namePatternFrom(input["pattern"]);
  if (named === null) return null;
  return scope === null ? named : { ...named, ...scope };
}

/**
 * The first line of a symbol append, which has to say when the list is partial.
 *
 * Three things shorten it: the label filter dropping rows, the append bound
 * cutting the ranking, and the graph holding more matches than the pool asked
 * for. All three mean the same thing to a reader -- these are not all of them --
 * and a heading reading "12 symbol(s) matching this grep" while 19 matched is
 * the misreading worth a clause to prevent.
 *
 * The second is why `listed` is the number of rows the block kept rather than
 * the ranking's length: the bound drops rows after the ranking is built, so a
 * count taken before that names symbols the append does not carry.
 *
 * The third is worth a different clause. When `has_more` is set, the in-degree
 * ranking ran over the page the graph returned rather than over every match, so
 * "highest in-degree first" of 285 would claim a ranking nothing performed.
 */
function symbolHeading(
  tool: string,
  project: string,
  listed: number,
  pooled: number,
  structured: unknown,
): string {
  const total = totalOf(structured);
  const paged = hasMore(structured);
  if (listed >= (total ?? pooled) && !paged) {
    return `Codebase graph — ${listed} symbol(s) matching this ${tool} in project ${project}:`;
  }

  const matched = total === null ? `${pooled}${paged ? "+" : ""}` : `${total}`;
  const ranking = paged ? `highest in-degree of the first ${CANDIDATE_LIMIT}` : "highest in-degree first";
  return `Codebase graph — ${listed} of ${matched} symbol(s) matching this ${tool} in project ${project}, ${ranking}:`;
}

/** The full match count the response declares, or `null` when it declares none. */
function totalOf(structured: unknown): number | null {
  if (typeof structured !== "object" || structured === null || !("total" in structured)) return null;
  const total = structured.total;
  return typeof total === "number" && Number.isFinite(total) ? total : null;
}

/** Whether the response says the graph held more matches than it returned. */
function hasMore(structured: unknown): boolean {
  return (
    typeof structured === "object" && structured !== null && "has_more" in structured && structured.has_more === true
  );
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
      if (rows.length >= CANDIDATE_LIMIT) break;
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
 * Appends one row list to `out`, bounded by {@link CANDIDATE_LIMIT}.
 *
 * The pool bound rather than the append bound: this is the candidate set the
 * in-degree ranking is chosen from, and cutting it to the append bound here
 * would put the choice back in the response's own order.
 *
 * `prefix` and `groupFile` supply what a grouped response keeps on the group
 * rather than on the row; a flat response passes neither and carries both in its
 * own columns.
 *
 * Rows whose label is not a definition are dropped. `name_pattern` matches a
 * `Module`, a `Section` or a `Branch` like anything else -- searching `resolve`
 * answers with the `resolve` Module and the `resolve.ts` File beside the three
 * real symbols -- and none of those is a definition the operator's search found.
 * The keyword mode filtered them upstream; this mode does not, so the filter
 * lives here. A response declaring no label column at all is left unfiltered,
 * because dropping every row of a shape this package has not seen would be the
 * silence {@link readRows} exists to avoid.
 */
function collect(
  out: SymbolRow[],
  rows: readonly unknown[],
  columns: Columns,
  prefix: string,
  groupFile: string,
): void {
  for (const row of rows) {
    if (out.length >= CANDIDATE_LIMIT) return;
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
    if (columns.label >= 0 && DEFINITION_LABELS[label] !== true) continue;

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
 *
 * The same argument governs the recommended action, which is suppressed when
 * nothing could act on it: see {@link actionable}.
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

    const recorded =
      "coverage" in entry && Array.isArray(entry.coverage) ? (entry.coverage as readonly unknown[]) : [];
    const gaps = recorded.slice(0, COVERAGE_LIMIT);
    const action =
      "recommended_action" in entry && typeof entry.recommended_action === "string" ? entry.recommended_action : "";
    const advise = action !== "" && (gaps.length === 0 || gaps.some(actionable));

    // Bounded on its own, not left to the drop rule: `status` and `action` are
    // both server-chosen and unbounded, and this is the row `graph-augmentation
    // "Scenario: Read of a partially covered file"` requires -- dropping it
    // leaves an append that reports no reason at all, which is what a 20,000
    // character `status` measured before this cut existed (126 bytes, heading
    // and caveat, zero rows). Cut rather than dropped for the same reason the
    // frame is: the obligation is that the reason be there, and a cut one still
    // names the path and the status it starts with. Later gap rows keep the
    // whole-row rule, because the reason precedes them and survives their loss.
    findings.push(cut(`- ${relative}: ${status}${advise ? ` (${action})` : ""}`, FRAME_LIMIT_BYTES));
    for (const gap of gaps) {
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
  // The heading carries no count, so it ignores the rows kept -- unlike a symbol
  // heading, it cannot state a number the block does not list.
  return block(() => `Codebase graph coverage for this read (project ${project}):`, findings, caveat);
}

/**
 * Whether a recorded gap is one the recommended action could actually close.
 *
 * `read_source_and_reindex` is what CBM recommends for every uncovered path,
 * and under `node_modules` or `dist` it names something nobody will do: the
 * directory is excluded by configuration, and the finding matched an ancestor
 * rather than the file itself. Advice that cannot be followed, attached to
 * every read of a dependency, is how a caveat gets trained into background
 * noise -- the outcome the no-append-when-clean rule above exists to avoid. The
 * reason and the completeness caveat stay, because `graph-augmentation
 * "Scenario: Read of a partially covered file"` requires both; only the
 * instruction goes.
 */
function actionable(gap: unknown): boolean {
  if (typeof gap !== "object" || gap === null) return false;
  if ("kind" in gap && gap.kind === "not_indexed_dir") return false;
  if ("match" in gap && gap.match === "ancestor") return false;
  return true;
}

/**
 * One appended block -- a heading, its rows, and a closing note -- bounded to
 * {@link APPEND_LIMIT_BYTES}.
 *
 * Bytes rather than the string's `length`, which counts UTF-16 code units: an
 * identifier in a non-Latin script costs three bytes a character, so a
 * character count under-measures the very thing the bound protects. Rows are
 * dropped whole and from the end, because a cut inside a row leaves half a
 * qualified name and half a line range, which reads as a symbol that does not
 * exist.
 *
 * `heading` takes the number of rows the block kept rather than a finished
 * string, because a heading naming a count the bound then dropped rows out from
 * under is a false statement rather than a truncation -- the same falsehood the
 * frame bound below exists to prevent, reached through the other
 * server-supplied string. Measured before the count came from the rows: twelve
 * 655-byte CJK rows produced `12 symbol(s) matching this grep` above FIVE rows,
 * one 3.9 kB row produced the same heading above NONE, and a sweep of 2,000
 * randomised symbol appends mismatched on 785 of them.
 *
 * The count and the rows are settled together, in a loop, because each decides
 * the other: the heading's weight decides how many rows fit, while the rows
 * kept decide the count -- and a shortened list takes the wider `N of M` form,
 * so re-deriving the heading after choosing the rows could overrun the bound
 * this function exists to hold. The loop ends because the reserve only grows,
 * so the rows kept only shrink, so `listed` strictly descends until it agrees
 * with them. Measured worst case: three passes across 10,800 row-count and
 * row-size pairs, two when the heading carries no count -- the coverage one --
 * and one, no re-heading at all, whenever nothing was dropped.
 *
 * Weighing the heading at {@link FRAME_LIMIT_BYTES} unconditionally is one pass
 * and no loop, and was rejected on measurement: it spends 512 bytes on a
 * heading that measures 66, and so drops a row that would have fit at 440 of
 * the 841 row sizes swept -- every one of them at 289 bytes a row or more,
 * which is well inside what a deep-package monorepo produces. Twelve 300-byte
 * rows come back whole here, at 3,790 bytes, against eleven rows and an
 * `11 of 12` claim under the reservation.
 *
 * The heading and the note are cut instead of dropped, each to
 * {@link FRAME_LIMIT_BYTES}: the note is the caveat a coverage block is
 * required to carry and the heading is what says the list is partial, so
 * neither may vanish -- but neither is wholly this package's own text either,
 * because both interpolate a string the server chose. Seeding `size` with an
 * unbounded frame is what let a 9,000-byte `caveat` and a 9,000-byte project
 * name each produce a ~9 kB append carrying no rows at all.
 *
 * The bound wins when the two obligations conflict, and the frame is what pays.
 * {@link APPEND_LIMIT_BYTES} is the operator's context window, so exceeding it
 * is not an option a heading can buy its way out of; the rows are what the
 * block exists to carry, so they get the reserve. A frame cut short still says
 * what it is, and every real frame fits: no truncation happens on any input
 * this package or CBM has been observed to produce.
 *
 * The result cannot exceed the bound rather than being clamped to it. `size`
 * counts one newline per line and the join writes one fewer, so the assembled
 * string is at most `size - 1` bytes and `size` never passes the limit -- and a
 * clamp at the return site would cut mid-row, which is the failure the
 * whole-row rule above exists to prevent.
 */
function block(heading: (listed: number) => string, rows: readonly string[], note: string): string {
  const bytes = (line: string): number => ENCODER.encode(line).length + 1;
  const closing = cut(note, FRAME_LIMIT_BYTES);
  let reserve = 0;
  let listed = rows.length;
  for (;;) {
    const framed = cut(heading(listed), FRAME_LIMIT_BYTES);
    // Only ever grows, which is what makes the descent terminate. It may
    // exceed this pass's own heading, which only leaves the block shorter than
    // the bound rather than longer.
    reserve = Math.max(reserve, bytes(framed));
    let size = reserve + bytes(closing);
    const kept: string[] = [];
    for (const row of rows) {
      const cost = bytes(row);
      if (size + cost > APPEND_LIMIT_BYTES) break;
      size += cost;
      kept.push(row);
    }
    if (kept.length === listed) return [framed, ...kept, closing].join("\n");
    listed = kept.length;
  }
}

/**
 * `line`, at most `limit` bytes, cut on a UTF-8 character boundary.
 *
 * `TextEncoder.encodeInto` is what makes the cut safe, and it is the reason this
 * is not `line.slice()`. Neither unit a `slice` can take is the right one: a
 * byte offset lands inside a three-byte CJK character, and a code-unit offset
 * halves a surrogate pair, so a caveat in Japanese or a name outside the BMP
 * comes back holding a partial sequence that is not text. `encodeInto` fills the
 * buffer with whole code points and reports how many code units that consumed,
 * so `read` is exactly the prefix that fits -- one pass, no per-character loop.
 * Verified across every alignment: cutting `"a" * n + "𝕏" * 4000` for n in 0..4
 * round-trips through a `fatal` decoder every time.
 */
function cut(line: string, limit: number): string {
  if (ENCODER.encode(line).length <= limit) return line;
  const room = new Uint8Array(limit - CUT_MARK_BYTES);
  const { read } = ENCODER.encodeInto(line, room);
  return `${line.slice(0, read)}${CUT_MARK}`;
}
