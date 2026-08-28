// @bun
// src/augment-entry.ts
import { existsSync } from "fs";

// src/augment.ts
import path2 from "path";

// src/project.ts
import path from "path";
function selectProject(projects, cwd) {
  const directory = path.resolve(cwd);
  let best = null;
  for (const candidate of projects) {
    const root = path.resolve(candidate.root);
    if (root !== directory && !directory.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`))
      continue;
    if (best === null || path.resolve(best.root).length < root.length)
      best = candidate;
  }
  return best;
}
function readProjects(structured) {
  if (typeof structured !== "object" || structured === null || !("projects" in structured))
    return null;
  const listed = structured.projects;
  if (!Array.isArray(listed))
    return null;
  const projects = [];
  for (const entry of listed) {
    if (typeof entry !== "object" || entry === null)
      continue;
    if (!("name" in entry) || !("root_path" in entry))
      continue;
    const { name, root_path: root } = entry;
    if (typeof name !== "string" || typeof root !== "string" || name === "" || root === "")
      continue;
    projects.push({ name, root });
  }
  return projects;
}
function projectResolver(client, cwd) {
  let settled = null;
  let inFlight = null;
  return {
    async resolve() {
      if (settled !== null)
        return settled;
      inFlight ??= (async () => {
        try {
          const projects = readProjects(await client.call("list_projects", {}));
          if (projects === null)
            return { kind: "unavailable" };
          const project = selectProject(projects, cwd);
          return project === null ? { kind: "unindexed" } : { kind: "project", project };
        } finally {
          inFlight = null;
        }
      })();
      const answer = await inFlight;
      if (answer.kind !== "unavailable")
        settled = answer;
      return answer;
    }
  };
}

// src/augment.ts
var SYMBOL_LIMIT = 12;
var CANDIDATE_LIMIT = 50;
var COVERAGE_LIMIT = 8;
var APPEND_LIMIT_BYTES = 4096;
var FRAME_LIMIT_BYTES = 512;
var ENCODER = new TextEncoder;
var CUT_MARK = "\u2026";
var CUT_MARK_BYTES = ENCODER.encode(CUT_MARK).length;
var IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]{2,}/gu;
var QUERY_TOKEN_LIMIT = 4;
var DEFINITION_LABELS = {
  Class: true,
  Enum: true,
  Function: true,
  Interface: true,
  Method: true,
  Struct: true,
  Trait: true,
  Type: true,
  Variable: true
};
var CLEAN_COVERAGE = "no_recorded_issue";
var COVERAGE_CAVEAT = "A clean coverage result means no recorded gap, not proof of completeness.";
function createAugmenter(deps) {
  let opened = null;
  let client = null;
  let closed = false;
  const notified = new Set;
  const notifyOnce = (message) => {
    if (notified.has(message))
      return;
    notified.add(message);
    deps.notify(message);
  };
  const session = async () => {
    opened ??= (async () => {
      try {
        const opening = await deps.openClient();
        if (opening === null)
          return null;
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
        if (event.isError)
          return;
        if (event.toolName !== "grep" && event.toolName !== "glob" && event.toolName !== "read")
          return;
        const active = await session();
        if (active === null)
          return;
        const resolution = await active.resolver.resolve();
        if (resolution.kind === "unavailable")
          return;
        if (resolution.kind === "unindexed") {
          notifyOnce("codebase-memory-mcp: no indexed project covers this directory, so graph context is not being added. " + "Ask the agent to index it, or run /cbm status to see the resolution.");
          return;
        }
        const appended = event.toolName === "read" ? await coverageFor(active.client, resolution.project.name, resolution.project.root, event.input, deps.cwd) : await symbolsFor(active.client, resolution.project.name, event.toolName, event.input);
        if (appended === null)
          return;
        return {
          content: [...event.content, { type: "text", text: appended }]
        };
      } catch (error) {
        deps.debug(`augmentation failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    },
    async warm() {
      const started = Date.now();
      try {
        const active = await session();
        if (active === null)
          return;
        const ready = await active.client.toolNames() !== null;
        const resolution = await active.resolver.resolve();
        deps.debug(`warm-up ${ready ? "ready" : "incomplete"} in ${Date.now() - started}ms, project ${resolution.kind}`);
      } catch (error) {
        deps.debug(`warm-up failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    close() {
      closed = true;
      client?.close();
      client = null;
    }
  };
}
async function symbolsFor(client, project, tool, input) {
  const selector = selectorFor(tool, input);
  if (selector === null)
    return null;
  const structured = await client.call("search_graph", {
    project,
    ...selector,
    limit: CANDIDATE_LIMIT,
    format: "json"
  });
  const rows = readRows(structured);
  if (rows === null || rows.length === 0)
    return null;
  const ranked = [...rows].sort((left, right) => right.inDegree - left.inDegree).slice(0, SYMBOL_LIMIT);
  const lines = ranked.map((row) => `- ${row.qualified} (${row.label}) ${row.file}${row.lines}${degreeOf(row)}`);
  const carriesDegree = ranked.some((row) => row.inDegree >= 0);
  return block((listed) => symbolHeading(tool, project, listed, rows.length, structured), lines, carriesDegree ? "in/out is selected graph degree, not a caller count; use trace_path for callers or get_code_snippet for source." : "Use trace_path for callers or get_code_snippet for exact source.");
}
function selectorFor(tool, input) {
  const scope = filePatternFrom(input["path"]);
  if (tool === "glob")
    return scope;
  const named = namePatternFrom(input["pattern"]);
  if (named === null)
    return null;
  return scope === null ? named : { ...named, ...scope };
}
function symbolHeading(tool, project, listed, pooled, structured) {
  const total = totalOf(structured);
  const paged = hasMore(structured);
  if (listed >= (total ?? pooled) && !paged) {
    return `Codebase graph \u2014 ${listed} symbol(s) matching this ${tool} in project ${project}:`;
  }
  const matched = total === null ? `${pooled}${paged ? "+" : ""}` : `${total}`;
  const ranking = paged ? `highest in-degree of the first ${CANDIDATE_LIMIT}` : "highest in-degree first";
  return `Codebase graph \u2014 ${listed} of ${matched} symbol(s) matching this ${tool} in project ${project}, ${ranking}:`;
}
function totalOf(structured) {
  if (typeof structured !== "object" || structured === null || !("total" in structured))
    return null;
  const total = structured.total;
  return typeof total === "number" && Number.isFinite(total) ? total : null;
}
function hasMore(structured) {
  return typeof structured === "object" && structured !== null && "has_more" in structured && structured.has_more === true;
}
function degreeOf(row) {
  return row.inDegree < 0 ? "" : ` \u2014 ${row.inDegree} in / ${row.outDegree} out`;
}
function namePatternFrom(pattern) {
  if (typeof pattern !== "string")
    return null;
  const tokens = [...new Set([...pattern.matchAll(IDENTIFIER)].map((match) => match[0]))].slice(0, QUERY_TOKEN_LIMIT);
  return tokens.length === 0 ? null : { name_pattern: `(${tokens.join("|")})` };
}
function filePatternFrom(value) {
  if (typeof value !== "string")
    return null;
  const glob = value.split(";")[0]?.trim() ?? "";
  if (glob === "" || glob === ".")
    return null;
  const like = glob.replaceAll("?", "_").replace(/\*+\/?/gu, "%").replace(/%+/gu, "%");
  return like === "%" ? null : { file_pattern: like };
}
function readRows(structured) {
  if (typeof structured !== "object" || structured === null || !("cols" in structured))
    return null;
  const declared = structured.cols;
  if (!Array.isArray(declared))
    return null;
  const at = (key) => declared.indexOf(key);
  const columns = {
    qn: at("qn"),
    name: at("name"),
    label: at("label"),
    file: at("file"),
    lines: at("lines"),
    in: at("in"),
    out: at("out")
  };
  if (columns.qn === -1 && columns.name === -1)
    return null;
  const rows = [];
  if ("rows" in structured && Array.isArray(structured.rows)) {
    collect(rows, structured.rows, columns, "", "");
    return rows;
  }
  if ("groups" in structured && Array.isArray(structured.groups)) {
    for (const group of structured.groups) {
      if (rows.length >= CANDIDATE_LIMIT)
        break;
      if (typeof group !== "object" || group === null || !("rows" in group))
        continue;
      if (!Array.isArray(group.rows))
        continue;
      const prefix = "qn_prefix" in group && typeof group.qn_prefix === "string" ? group.qn_prefix : "";
      const file = "file" in group && typeof group.file === "string" ? group.file : "";
      collect(rows, group.rows, columns, prefix, file);
    }
    return rows;
  }
  return null;
}
function collect(out, rows, columns, prefix, groupFile) {
  for (const row of rows) {
    if (out.length >= CANDIDATE_LIMIT)
      return;
    if (!Array.isArray(row))
      continue;
    const cell = (index) => {
      if (index < 0)
        return "";
      const value = row[index];
      return typeof value === "string" ? value : "";
    };
    const count = (index) => {
      if (index < 0)
        return -1;
      const value = row[index];
      return typeof value === "number" && Number.isFinite(value) ? value : -1;
    };
    const bare = cell(columns.name);
    const qualified = columns.qn >= 0 ? cell(columns.qn) : prefix === "" ? bare : `${prefix}.${bare}`;
    if (qualified === "" || qualified.endsWith("__file__"))
      continue;
    const label = cell(columns.label) === "" ? "symbol" : cell(columns.label);
    if (columns.label >= 0 && DEFINITION_LABELS[label] !== true)
      continue;
    const lines = cell(columns.lines);
    out.push({
      qualified,
      label,
      file: cell(columns.file) === "" ? groupFile : cell(columns.file),
      lines: lines === "" ? "" : `:${lines}`,
      inDegree: count(columns.in),
      outDegree: count(columns.out)
    });
  }
}
async function coverageFor(client, project, root, input, cwd) {
  const target = input["path"];
  if (typeof target !== "string" || target === "")
    return null;
  if (target.includes("://"))
    return null;
  const relative = path2.relative(root, path2.resolve(cwd, target.split(":")[0] ?? target));
  if (relative === "" || relative.startsWith("..") || path2.isAbsolute(relative))
    return null;
  const structured = await client.call("check_index_coverage", { project, paths: [relative] });
  if (typeof structured !== "object" || structured === null || !("paths" in structured))
    return null;
  const reported = structured.paths;
  if (!Array.isArray(reported))
    return null;
  const findings = [];
  for (const entry of reported) {
    if (typeof entry !== "object" || entry === null || !("status" in entry))
      continue;
    const status = entry.status;
    if (typeof status !== "string" || status === CLEAN_COVERAGE)
      continue;
    const recorded = "coverage" in entry && Array.isArray(entry.coverage) ? entry.coverage : [];
    const gaps = recorded.slice(0, COVERAGE_LIMIT);
    const action = "recommended_action" in entry && typeof entry.recommended_action === "string" ? entry.recommended_action : "";
    const advise = action !== "" && (gaps.length === 0 || gaps.some(actionable));
    findings.push(cut(`- ${relative}: ${status}${advise ? ` (${action})` : ""}`, FRAME_LIMIT_BYTES));
    for (const gap of gaps) {
      if (typeof gap !== "object" || gap === null)
        continue;
      const where = "path" in gap && typeof gap.path === "string" ? gap.path : relative;
      const kind = "kind" in gap && typeof gap.kind === "string" ? gap.kind : "unknown";
      const detail = "detail" in gap && typeof gap.detail === "string" ? gap.detail : "";
      findings.push(`  - ${where}: ${kind}${detail === "" ? "" : ` \u2014 ${detail}`}`);
    }
  }
  if (findings.length === 0)
    return null;
  const caveat = "caveat" in structured && typeof structured.caveat === "string" && structured.caveat !== "" ? structured.caveat : COVERAGE_CAVEAT;
  return block(() => `Codebase graph coverage for this read (project ${project}):`, findings, caveat);
}
function actionable(gap) {
  if (typeof gap !== "object" || gap === null)
    return false;
  if ("kind" in gap && gap.kind === "not_indexed_dir")
    return false;
  if ("match" in gap && gap.match === "ancestor")
    return false;
  return true;
}
function block(heading, rows, note) {
  const bytes = (line) => ENCODER.encode(line).length + 1;
  const closing = cut(note, FRAME_LIMIT_BYTES);
  let reserve = 0;
  let listed = rows.length;
  for (;; ) {
    const framed = cut(heading(listed), FRAME_LIMIT_BYTES);
    reserve = Math.max(reserve, bytes(framed));
    let size = reserve + bytes(closing);
    const kept = [];
    for (const row of rows) {
      const cost = bytes(row);
      if (size + cost > APPEND_LIMIT_BYTES)
        break;
      size += cost;
      kept.push(row);
    }
    if (kept.length === listed)
      return [framed, ...kept, closing].join(`
`);
    listed = kept.length;
  }
}
function cut(line, limit) {
  if (ENCODER.encode(line).length <= limit)
    return line;
  const room = new Uint8Array(limit - CUT_MARK_BYTES);
  const { read } = ENCODER.encodeInto(line, room);
  return `${line.slice(0, read)}${CUT_MARK}`;
}

// src/exec.ts
var OUTPUT_LIMIT_BYTES = 262144;

// src/graph.ts
var HANDSHAKE_TIMEOUT_MS = 20000;
var QUERY_TIMEOUT_MS = 300;
var REOPEN_LIMIT = 2;
var PROTOCOL_VERSION = "2024-11-05";
var EXPIRED = Symbol("deadline");
function openGraphClient(executable, options = {}) {
  const queryTimeoutMs = options.queryTimeoutMs ?? QUERY_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs;
  const debug = options.onDebug ?? (() => {});
  let expiresAt = null;
  const budgeted = (timeoutMs) => {
    if (totalTimeoutMs === undefined)
      return timeoutMs;
    expiresAt ??= Date.now() + totalTimeoutMs;
    return Math.max(0, Math.min(timeoutMs, expiresAt - Date.now()));
  };
  let child = null;
  let handshake = null;
  let established = false;
  let declined = false;
  let opens = 0;
  let closed = false;
  let nextId = 0;
  const pending = new Map;
  const teardown = (reason, owner) => {
    if (owner !== child)
      return;
    for (const settle of pending.values())
      settle({ error: { message: reason } });
    pending.clear();
    const dying = child;
    child = null;
    handshake = null;
    established = false;
    if (dying === null)
      return;
    try {
      dying.stdin.end();
    } catch {}
    try {
      dying.kill();
    } catch {}
  };
  const drain = (owner, stream, onLine) => {
    (async () => {
      const reader = stream.getReader();
      const decoder = new TextDecoder;
      let buffer = "";
      try {
        for (;; ) {
          const { done, value } = await reader.read();
          if (done)
            break;
          if (onLine === null)
            continue;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > OUTPUT_LIMIT_BYTES) {
            teardown(`the graph session wrote more than ${OUTPUT_LIMIT_BYTES} bytes without a complete line`, owner);
            return;
          }
          let newline = buffer.indexOf(`
`);
          while (newline >= 0) {
            onLine(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf(`
`);
          }
        }
      } catch (error) {
        debug(`graph session read failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await reader.cancel().catch(() => {});
        if (onLine !== null)
          teardown("the graph session ended", owner);
      }
    })();
  };
  const receive = (line) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null || !("id" in parsed))
      return;
    const id = parsed.id;
    if (typeof id !== "number")
      return;
    const settle = pending.get(id);
    if (settle === undefined)
      return;
    pending.delete(id);
    settle(parsed);
  };
  const request = async (method, params, timeoutMs) => {
    const active = child;
    if (active === null)
      return null;
    const id = ++nextId;
    const bound = budgeted(timeoutMs);
    const answered = Promise.withResolvers();
    pending.set(id, answered.resolve);
    const deadline = AbortSignal.timeout(bound);
    const expired = Promise.withResolvers();
    deadline.addEventListener("abort", () => expired.resolve(EXPIRED), { once: true });
    try {
      active.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}
`);
      await active.stdin.flush();
    } catch (error) {
      pending.delete(id);
      teardown(`the graph session would not accept a request: ${error instanceof Error ? error.message : String(error)}`, active);
      return null;
    }
    const response = await Promise.race([answered.promise, expired.promise]);
    if (response === EXPIRED) {
      pending.delete(id);
      teardown(`${method} did not answer within ${bound}ms`, active);
      debug(`graph query ${method} exceeded ${bound}ms`);
      return null;
    }
    if (typeof response !== "object" || response === null)
      return null;
    if ("error" in response) {
      const failure = response.error;
      const reported = typeof failure === "object" && failure !== null && "message" in failure && typeof failure.message === "string" ? failure.message : "unknown";
      debug(`graph query ${method} failed: ${reported}`);
      return null;
    }
    return "result" in response ? response.result ?? null : null;
  };
  const open = async () => {
    let started;
    try {
      started = Bun.spawn([executable], { stdout: "pipe", stderr: "pipe", stdin: "pipe" });
    } catch (error) {
      debug(`graph session would not start: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    child = started;
    drain(started, started.stdout, receive);
    drain(started, started.stderr, null);
    const initialized = await request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "omp-codebase-memory", version: "0" }
    }, HANDSHAKE_TIMEOUT_MS);
    if (initialized === null) {
      teardown("the graph session did not complete its handshake", started);
      return false;
    }
    if (child !== started)
      return false;
    try {
      started.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}
`);
      await started.stdin.flush();
    } catch (error) {
      teardown("the graph session would not accept the initialized notification: " + `${error instanceof Error ? error.message : String(error)}`, started);
      return false;
    }
    if (child !== started)
      return false;
    established = true;
    return true;
  };
  const ready = async () => {
    if (closed || declined)
      return false;
    const inFlight = handshake;
    if (inFlight !== null)
      return await inFlight;
    if (opens > REOPEN_LIMIT)
      return false;
    opens += 1;
    const started = open();
    handshake = started;
    const opened = await started;
    if (!opened) {
      declined = true;
      if (handshake === started)
        handshake = null;
    }
    return opened;
  };
  const readyNow = () => {
    ready().catch(() => {});
    return established;
  };
  return {
    async call(tool, args) {
      if (!readyNow())
        return null;
      const result = await request("tools/call", { name: tool, arguments: args }, queryTimeoutMs);
      if (typeof result !== "object" || result === null)
        return null;
      if ("isError" in result && result.isError === true) {
        debug(`graph tool ${tool} reported an error`);
        return null;
      }
      return "structuredContent" in result ? result.structuredContent ?? null : null;
    },
    async toolNames() {
      if (!await ready())
        return null;
      const result = await request("tools/list", {}, HANDSHAKE_TIMEOUT_MS);
      if (typeof result !== "object" || result === null || !("tools" in result))
        return null;
      const tools = result.tools;
      if (!Array.isArray(tools))
        return null;
      return tools.map((tool) => typeof tool === "object" && tool !== null && ("name" in tool) ? tool.name : undefined).filter((name) => typeof name === "string");
    },
    close() {
      closed = true;
      teardown("the graph session was closed", child);
    }
  };
}

// src/paths.ts
import { homedir } from "os";
import path3 from "path";
function processHost() {
  return { home: homedir(), env: process.env };
}
var EXECUTABLE_NAME = "codebase-memory-mcp";
function configDirName(host) {
  const override = host.env["PI_CONFIG_DIR"];
  return override !== undefined && override !== "" ? override : ".omp";
}
function agentDir(host) {
  const explicit = host.env["PI_CODING_AGENT_DIR"];
  if (explicit !== undefined && explicit !== "")
    return path3.resolve(explicit);
  const omp = host.env["OMP_PROFILE"];
  const profile = omp !== undefined ? omp : host.env["PI_PROFILE"];
  const root = path3.join(host.home, configDirName(host));
  return profile !== undefined && profile !== "" ? path3.join(root, "profiles", profile, "agent") : path3.join(root, "agent");
}
function nativeExtensionPath(host) {
  return path3.join(agentDir(host), "extensions", "codebase-memory.ts");
}
function packageRoot(host) {
  return path3.join(host.home, configDirName(host), "codebase-memory");
}
function managedBinRoot(host) {
  return path3.join(packageRoot(host), "bin");
}
function managedExecutable(host, version) {
  return path3.join(managedBinRoot(host), version, EXECUTABLE_NAME);
}
function statePath(host) {
  return path3.join(packageRoot(host), "state.json");
}
function upstreamInstallDir(host) {
  return path3.join(host.home, ".local", "bin");
}

// src/state.ts
var EMPTY = {};
async function readState(host) {
  const file = Bun.file(statePath(host));
  let text;
  try {
    text = await file.text();
  } catch {
    return EMPTY;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return EMPTY;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return EMPTY;
  const record = parsed;
  const state = {};
  for (const key of ["managedVersion", "managedDigest", "pin", "upstreamVersion", "wroteCommand"]) {
    const value = record[key];
    if (typeof value === "string" && value !== "")
      state[key] = value;
  }
  const lastCheckedAt = record["lastCheckedAt"];
  if (typeof lastCheckedAt === "number" && Number.isFinite(lastCheckedAt)) {
    state["lastCheckedAt"] = lastCheckedAt;
  }
  return state;
}

// src/resolve.ts
import path4 from "path";
var NO_EXECUTABLE_REASON = `no ${EXECUTABLE_NAME} executable found on PATH, in ~/.local/bin, or under this package's own root. ` + "Run /cbm install to download a managed copy, or install it yourself with " + "`curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash` " + "and this package will adopt it.";
async function managedCopy(host, state) {
  const recorded = (state ?? await readState(host)).managedVersion;
  if (recorded === undefined)
    return null;
  const executable = managedExecutable(host, recorded);
  return await Bun.file(executable).exists() ? { version: recorded, executable } : null;
}
async function resolveExecutable(host, state) {
  const current = state ?? await readState(host);
  const pin = current.pin;
  if (pin !== undefined) {
    const pinned = managedExecutable(host, pin);
    if (await Bun.file(pinned).exists()) {
      return { ok: true, resolved: { executable: pinned, source: "pin", origin: pin } };
    }
  }
  const onPath = Bun.which(EXECUTABLE_NAME, pathOption(host));
  if (onPath !== null) {
    return {
      ok: true,
      resolved: { executable: path4.resolve(onPath), source: "system", origin: "PATH" }
    };
  }
  const upstream = path4.join(upstreamInstallDir(host), EXECUTABLE_NAME);
  if (await Bun.file(upstream).exists()) {
    return {
      ok: true,
      resolved: { executable: upstream, source: "system", origin: "~/.local/bin" }
    };
  }
  const managed = await managedCopy(host, current);
  if (managed !== null) {
    return {
      ok: true,
      resolved: {
        executable: managed.executable,
        source: "managed",
        origin: path4.join(path4.basename(managedBinRoot(host)), managed.version)
      }
    };
  }
  return { ok: false, reason: NO_EXECUTABLE_REASON };
}
function pathOption(host) {
  return { PATH: host.env["PATH"] ?? "" };
}

// src/scheduler.ts
function schedulerFrom(ctx) {
  return {
    after(callback, ms) {
      return ctx.setTimeout(callback, ms);
    },
    cancel(handle) {
      ctx.clearTimer(handle);
    }
  };
}

// src/augment-entry.ts
var WARM_DELAY_MS = 0;
function ompCodebaseMemoryAugmentation(pi) {
  const host = processHost();
  const native = nativeExtensionPath(host);
  if (existsSync(native)) {
    pi.logger.info("omp-codebase-memory: augmentation standing down", { native });
    return;
  }
  let current = null;
  let augmenter = null;
  const debug = (message) => {
    pi.logger.info("omp-codebase-memory: augmentation", { message });
  };
  const ensure = (ctx) => {
    augmenter ??= createAugmenter({
      openClient: async () => {
        const resolution = await resolveExecutable(host, await readState(host));
        if (!resolution.ok) {
          debug(`no executable resolved: ${resolution.reason}`);
          return null;
        }
        return openGraphClient(resolution.resolved.executable, { onDebug: debug });
      },
      cwd: ctx.cwd,
      notify: (message) => {
        try {
          current?.ui.notify(message, "info");
        } catch (error) {
          debug(`notification failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
      debug
    });
    return augmenter;
  };
  pi.on("session_start", (_event, ctx) => {
    current = ctx;
    const augment = ensure(ctx);
    schedulerFrom(ctx).after(() => {
      augment.warm();
    }, WARM_DELAY_MS);
  });
  pi.on("tool_result", async (event, ctx) => {
    current = ctx;
    return await ensure(ctx).handle(event);
  });
  pi.on("session_shutdown", () => {
    augmenter?.close();
    augmenter = null;
    current = null;
  });
}
export {
  ompCodebaseMemoryAugmentation as default
};
