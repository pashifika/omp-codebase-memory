// @bun
// src/index.ts
import { existsSync } from "fs";

// src/platform.ts
import { cpus } from "os";

class UnsupportedPlatformError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsupportedPlatformError";
  }
}
function describeTarget(os, arch) {
  const container = os === "windows" ? "zip" : "tar.gz";
  const executable = os === "windows" ? "codebase-memory-mcp.exe" : "codebase-memory-mcp";
  const installer = os === "windows" ? "install.ps1" : "install.sh";
  const portable = os === "linux" ? "-portable" : "";
  const archive = `codebase-memory-mcp-${os}-${arch}${portable}.${container}`;
  return {
    os,
    arch,
    archive,
    container,
    executable,
    installer,
    members: [executable, "LICENSE", installer, "THIRD_PARTY_NOTICES.md"]
  };
}
function detectTarget(platform, arch, cpuModel) {
  let os;
  switch (platform) {
    case "darwin":
      os = "darwin";
      break;
    case "linux":
      os = "linux";
      break;
    case "win32":
      throw new UnsupportedPlatformError("Windows is not supported yet: the release archive is a zip this package cannot extract, " + "and the executable suffix and path handling are unimplemented. " + "Install codebase-memory-mcp with upstream's install.ps1 and this package will adopt it from PATH.");
    default:
      throw new UnsupportedPlatformError(`unsupported operating system: ${platform} (supported: darwin, linux)`);
  }
  let target;
  switch (arch) {
    case "arm64":
      target = "arm64";
      break;
    case "x64":
      target = os === "darwin" && /apple/i.test(cpuModel ?? "") ? "arm64" : "amd64";
      break;
    default:
      throw new UnsupportedPlatformError(`unsupported architecture: ${arch} (supported: arm64, x64)`);
  }
  return describeTarget(os, target);
}
function hostTarget() {
  return detectTarget(process.platform, process.arch, cpus()[0]?.model);
}

// src/paths.ts
import { homedir } from "os";
import path from "path";
function processHost() {
  return { home: homedir(), env: process.env };
}
var EXECUTABLE_NAME = "codebase-memory-mcp";
var SERVER_NAME = "codebase-memory-mcp";
function configDirName(host) {
  const override = host.env["PI_CONFIG_DIR"];
  return override !== undefined && override !== "" ? override : ".omp";
}
function agentDir(host) {
  const explicit = host.env["PI_CODING_AGENT_DIR"];
  if (explicit !== undefined && explicit !== "")
    return path.resolve(explicit);
  const omp = host.env["OMP_PROFILE"];
  const profile = omp !== undefined ? omp : host.env["PI_PROFILE"];
  const root = path.join(host.home, configDirName(host));
  return profile !== undefined && profile !== "" ? path.join(root, "profiles", profile, "agent") : path.join(root, "agent");
}
function mcpConfigPath(host) {
  return path.join(agentDir(host), "mcp.json");
}
function nativeExtensionPath(host) {
  return path.join(agentDir(host), "extensions", "codebase-memory.ts");
}
function packageRoot(host) {
  return path.join(host.home, configDirName(host), "codebase-memory");
}
function managedBinRoot(host) {
  return path.join(packageRoot(host), "bin");
}
function managedExecutable(host, version) {
  return path.join(managedBinRoot(host), version, EXECUTABLE_NAME);
}
function statePath(host) {
  return path.join(packageRoot(host), "state.json");
}
function upstreamInstallDir(host) {
  return path.join(host.home, ".local", "bin");
}

// src/release.ts
var UPSTREAM_REPO = "DeusData/codebase-memory-mcp";
var RELEASES = `https://github.com/${UPSTREAM_REPO}/releases`;
var LATEST = `${RELEASES}/latest`;
var MAX_REDIRECTS = 5;
var DEFAULT_TIMEOUT_MS = 20000;
var CHECKSUMS_LIMIT_BYTES = 1048576;
async function fetchHttps(url, options = {}) {
  const budget = Math.min(options.maxRedirects ?? MAX_REDIRECTS, MAX_REDIRECTS);
  let current = requireHttps(url, "request");
  for (let hop = 0;; hop++) {
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: { accept: "*/*" }
    });
    const redirected = response.status >= 300 && response.status < 400;
    if (!redirected || hop >= budget)
      return response;
    const location = response.headers.get("location");
    if (location === null) {
      throw new Error(`${current} answered ${response.status} with no location header`);
    }
    current = requireHttps(new URL(location, current).href, "redirect");
  }
}
function requireHttps(url, kind) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error(`refusing non-HTTPS ${kind}: ${url}`);
  }
  return parsed.href;
}
async function resolveLatestTag() {
  const response = await fetchHttps(LATEST, { maxRedirects: 0 });
  if (response.status < 300 || response.status >= 400) {
    throw new Error(`expected ${LATEST} to redirect to a tag, got HTTP ${response.status}`);
  }
  const location = response.headers.get("location");
  if (location === null) {
    throw new Error(`${LATEST} answered ${response.status} with no location header`);
  }
  const resolved = new URL(location, LATEST);
  if (resolved.protocol !== "https:") {
    throw new Error(`refusing non-HTTPS release location: ${resolved.href}`);
  }
  const prefix = `/${UPSTREAM_REPO}/releases/tag/`;
  if (!resolved.pathname.startsWith(prefix)) {
    throw new Error(`unexpected release location: ${resolved.href}`);
  }
  const tag = decodeURIComponent(resolved.pathname.slice(prefix.length));
  if (tag === "" || tag.includes("/")) {
    throw new Error(`unexpected release tag in location: ${resolved.href}`);
  }
  return tag;
}
function parseChecksums(body, archive) {
  if (body.byteLength > CHECKSUMS_LIMIT_BYTES) {
    throw new Error(`checksums.txt is ${body.byteLength} bytes, over the ${CHECKSUMS_LIMIT_BYTES} byte safety limit`);
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(body);
  let digest;
  for (const line of text.split(`
`)) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 2)
      continue;
    const name = fields[1] ?? "";
    if (name !== archive && name !== `*${archive}`)
      continue;
    const candidate = (fields[0] ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(candidate)) {
      throw new Error(`invalid SHA-256 digest for ${archive}: ${fields[0] ?? ""}`);
    }
    if (digest !== undefined && digest !== candidate) {
      throw new Error(`conflicting SHA-256 digests for ${archive} in checksums.txt`);
    }
    digest = candidate;
  }
  if (digest === undefined) {
    throw new Error(`no SHA-256 digest for ${archive} in checksums.txt`);
  }
  return digest;
}
function githubReleaseSource() {
  return {
    latestTag: resolveLatestTag,
    checksums: (tag) => download(`${RELEASES}/download/${encodeURIComponent(tag)}/checksums.txt`),
    asset: (tag, name) => download(`${RELEASES}/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`)
  };
}
async function download(url) {
  const response = await fetchHttps(url);
  if (!response.ok) {
    throw new Error(`GET ${url} answered HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

// src/exec.ts
var DEFAULT_TIMEOUT_MS2 = 30000;
async function run(argv, options = {}) {
  try {
    const child = Bun.spawn([...argv], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS2,
      ...options.cwd === undefined ? {} : { cwd: options.cwd }
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ]);
    return { ok: exitCode === 0, exitCode, stdout, stderr };
  } catch (error) {
    return {
      ok: false,
      exitCode: -1,
      stdout: "",
      stderr: "",
      spawnError: error instanceof Error ? error.message : String(error)
    };
  }
}
async function readVersion(executable) {
  const result = await run([executable, "--version"], { timeoutMs: 1e4 });
  if (!result.ok)
    return null;
  const reported = `${result.stdout}${result.stderr}`.trim();
  return reported === "" ? null : reported.split(`
`)[0]?.trim() ?? null;
}
function haveTool(tool, pathEnv) {
  return Bun.which(tool, pathEnv === undefined ? {} : { PATH: pathEnv }) !== null;
}

// src/state.ts
import { mkdir } from "fs/promises";
import path2 from "path";
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
async function writeState(host, next) {
  const file = statePath(host);
  await mkdir(path2.dirname(file), { recursive: true });
  await Bun.write(file, `${JSON.stringify(next, null, 2)}
`);
}
async function updateState(host, patch) {
  const next = { ...await readState(host), ...patch };
  await writeState(host, next);
  return next;
}

// src/resolve.ts
import path3 from "path";
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
      resolved: { executable: path3.resolve(onPath), source: "system", origin: "PATH" }
    };
  }
  const upstream = path3.join(upstreamInstallDir(host), EXECUTABLE_NAME);
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
        origin: path3.join(path3.basename(managedBinRoot(host)), managed.version)
      }
    };
  }
  return { ok: false, reason: NO_EXECUTABLE_REASON };
}
async function resolvedVersion(resolved) {
  return await readVersion(resolved.executable);
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

// src/lifecycle.ts
import { rm as rm2 } from "fs/promises";

// src/acquire.ts
import { chmod, lstat, mkdtemp, mkdir as mkdir2, rm } from "fs/promises";
import { tmpdir } from "os";
import path4 from "path";
var VERSION_PATTERN = /^[0-9][0-9A-Za-z.+-]*$/u;
function normalizeVersion(value) {
  const trimmed = value.trim().replace(/^v/iu, "");
  if (!VERSION_PATTERN.test(trimmed)) {
    throw new Error(`not a usable version: ${value}`);
  }
  return trimmed;
}
function tagFor(version) {
  return `v${version}`;
}
async function acquire(request) {
  const { host, target, source } = request;
  if (target.container !== "tar.gz") {
    throw new UnsupportedPlatformError(`cannot extract a ${target.container} archive; only tar.gz is implemented`);
  }
  if (!haveTool("tar", host.env["PATH"])) {
    throw new Error("tar is required to extract the release archive, and is not on PATH");
  }
  const version = request.version === undefined ? normalizeVersion(await source.latestTag()) : normalizeVersion(request.version);
  const tag = tagFor(version);
  const expected = parseChecksums(await source.checksums(tag), target.archive);
  const bytes = await source.asset(tag, target.archive);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  const actual = hasher.digest("hex");
  if (actual !== expected) {
    throw new Error(`SHA-256 mismatch for ${target.archive} at ${tag}: published ${expected}, downloaded ${actual}`);
  }
  const scratch = await mkdtemp(path4.join(tmpdir(), "omp-codebase-memory-"));
  try {
    const archive = path4.join(scratch, target.archive);
    await Bun.write(archive, bytes);
    await assertArchiveMembers(archive, target);
    await extract(archive, scratch, target);
    const candidate = path4.join(scratch, target.executable);
    await chmod(candidate, 493);
    if (target.os === "darwin")
      await repairMacOsSignature(host, candidate);
    const reportedVersion = await smokeCheck(candidate, target);
    return await adopt(host, { version, digest: expected, candidate, reportedVersion });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
async function assertArchiveMembers(archive, target) {
  const listed = await run(["tar", "-tzf", archive]);
  if (!listed.ok) {
    throw new Error(`could not enumerate ${path4.basename(archive)}: ${listed.stderr.trim() || listed.spawnError || `tar exited ${listed.exitCode}`}`);
  }
  const seen = new Map;
  for (const raw of listed.stdout.split(`
`)) {
    const member = raw.trim().replace(/^\.\//u, "").replace(/\/+$/u, "");
    if (member === "")
      continue;
    if (!target.members.includes(member)) {
      throw new Error(`release archive contains unexpected member: ${member}`);
    }
    seen.set(member, (seen.get(member) ?? 0) + 1);
  }
  for (const member of target.members) {
    const count = seen.get(member) ?? 0;
    if (count === 1)
      continue;
    throw new Error(count === 0 ? `release archive is missing member: ${member}` : `release archive contains member ${member} ${count} times`);
  }
}
async function extract(archive, into, target) {
  const extracted = await run(["tar", "--no-same-owner", "-xzf", archive, "-C", into]);
  if (!extracted.ok) {
    throw new Error(`could not extract ${path4.basename(archive)}: ${extracted.stderr.trim() || extracted.spawnError || `tar exited ${extracted.exitCode}`}`);
  }
  for (const member of target.members) {
    const entry = path4.join(into, member);
    let stats;
    try {
      stats = await lstat(entry);
    } catch {
      throw new Error(`release member is missing after extraction: ${member}`);
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`release member is not a regular file: ${member}`);
    }
  }
}
function repairHint(candidate) {
  return `xattr -cr ${candidate} && codesign --force --sign - ${candidate}`;
}
async function repairMacOsSignature(host, candidate) {
  const pathEnv = host.env["PATH"];
  for (const tool of ["xattr", "codesign"]) {
    if (!haveTool(tool, pathEnv)) {
      throw new Error(`${tool} is required to prepare a macOS binary and is not on PATH; ` + `install the Xcode command line tools, or repair the candidate yourself with \`${repairHint(candidate)}\``);
    }
  }
  await run(["xattr", "-d", "com.apple.quarantine", candidate], { timeoutMs: 1e4 });
  const signed = await run(["codesign", "--sign", "-", "--force", candidate], {
    timeoutMs: 60000
  });
  if (!signed.ok) {
    throw new Error(`could not ad-hoc sign the candidate: ${signed.stderr.trim() || `codesign exited ${signed.exitCode}`}. ` + `Repair it by hand with \`${repairHint(candidate)}\``);
  }
}
async function smokeCheck(candidate, target) {
  const reported = await readVersion(candidate);
  if (reported !== null)
    return reported;
  const suffix = target.os === "darwin" ? ` If macOS is refusing to run it, try \`${repairHint(candidate)}\`.` : "";
  throw new Error(`the downloaded executable failed to run \`--version\`.${suffix}`);
}
async function adopt(host, candidate) {
  const destination = path4.join(managedBinRoot(host), candidate.version);
  await mkdir2(destination, { recursive: true });
  const executable = path4.join(destination, path4.basename(candidate.candidate));
  await Bun.write(executable, Bun.file(candidate.candidate));
  await chmod(executable, 493);
  return {
    version: candidate.version,
    digest: candidate.digest,
    executable,
    reportedVersion: candidate.reportedVersion
  };
}

// src/mcp-config.ts
import { mkdir as mkdir3 } from "fs/promises";
import path5 from "path";
var MCP_SCHEMA_URL = "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";
async function readMcpFile(host) {
  const file = mcpConfigPath(host);
  let text;
  try {
    text = await Bun.file(file).text();
  } catch {
    return {
      ok: true,
      file: { path: file, text: null, document: {}, indent: "  ", trailingNewline: true }
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      reason: `${file} is not parseable JSON, so it was left untouched: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: `${file} does not hold a JSON object, so it was left untouched` };
  }
  return {
    ok: true,
    file: {
      path: file,
      text,
      document: parsed,
      indent: detectIndent(text),
      trailingNewline: text.endsWith(`
`)
    }
  };
}
async function upsertEntry(host, command, previouslyWrote) {
  const read = await readMcpFile(host);
  if (!read.ok)
    return read;
  const { file } = read;
  const servers = serverMap(file.document);
  const existing = servers[SERVER_NAME];
  if (existing !== undefined) {
    const currentCommand = commandOf(existing);
    const ours = currentCommand === command || currentCommand === previouslyWrote;
    if (!ours) {
      return {
        ok: false,
        reason: `${file.path} already defines ${SERVER_NAME} with command ${currentCommand ?? "(none)"}, ` + `which this package did not write. It was left untouched; the executable this package resolved is ${command}.`
      };
    }
  }
  const next = { ...file.document };
  if (file.text === null)
    next["$schema"] = MCP_SCHEMA_URL;
  const entry = {
    ...typeof existing === "object" && existing !== null && !Array.isArray(existing) ? existing : {},
    type: "stdio",
    command,
    args: []
  };
  next["mcpServers"] = { ...servers, [SERVER_NAME]: entry };
  const rendered = render(next, file);
  if (file.text === rendered)
    return { ok: true, change: "unchanged" };
  await mkdir3(path5.dirname(file.path), { recursive: true });
  await Bun.write(file.path, rendered);
  return { ok: true, change: file.text === null ? "created" : "updated" };
}
async function removeEntry(host, wroteCommand) {
  const read = await readMcpFile(host);
  if (!read.ok)
    return read;
  const { file } = read;
  if (file.text === null)
    return { ok: true, change: "absent" };
  const servers = serverMap(file.document);
  const existing = servers[SERVER_NAME];
  if (existing === undefined)
    return { ok: true, change: "absent" };
  const currentCommand = commandOf(existing);
  if (wroteCommand === undefined || currentCommand !== wroteCommand) {
    return {
      ok: false,
      reason: `${file.path} defines ${SERVER_NAME} with command ${currentCommand ?? "(none)"}, ` + `which is not what this package wrote (${wroteCommand ?? "nothing recorded"}). It was left in place.`
    };
  }
  const remaining = { ...servers };
  delete remaining[SERVER_NAME];
  const next = { ...file.document, mcpServers: remaining };
  await Bun.write(file.path, render(next, file));
  return { ok: true, change: "removed" };
}
async function entryStatus(host, resolvedCommand) {
  const read = await readMcpFile(host);
  if (!read.ok) {
    return { path: mcpConfigPath(host), present: false, current: false, problem: read.reason };
  }
  const existing = serverMap(read.file.document)[SERVER_NAME];
  if (existing === undefined) {
    return { path: read.file.path, present: false, current: false };
  }
  const command = commandOf(existing);
  return {
    path: read.file.path,
    present: true,
    ...command === undefined ? {} : { command },
    current: command !== undefined && command === resolvedCommand
  };
}
function serverMap(document) {
  const servers = document["mcpServers"];
  return typeof servers === "object" && servers !== null && !Array.isArray(servers) ? servers : {};
}
function commandOf(entry) {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry))
    return;
  const command = entry["command"];
  return typeof command === "string" ? command : undefined;
}
function detectIndent(text) {
  const match = /\n([ \t]+)"/u.exec(text);
  return match?.[1] ?? "  ";
}
function render(document, file) {
  const body = JSON.stringify(document, null, file.indent);
  return file.trailingNewline ? `${body}
` : body;
}

// src/lifecycle.ts
var CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
async function status(lifecycle) {
  const { host } = lifecycle;
  const state = await readState(host);
  const resolution = await resolveExecutable(host, state);
  const resolved = resolution.ok ? resolution.resolved : null;
  const lines = [];
  if (!resolution.ok) {
    lines.push(`executable: none (${resolution.reason})`);
  } else {
    const version = await resolvedVersion(resolution.resolved) ?? "unknown (it did not run)";
    lines.push(`executable: ${resolution.resolved.executable}`);
    lines.push(`source:     ${resolution.resolved.source} (${resolution.resolved.origin})`);
    lines.push(`version:    ${version}`);
  }
  const managed = await managedCopy(host, state);
  lines.push(managed === null ? "managed:    none under this package's root" : `managed:    ${managed.version} at ${managed.executable}` + (resolved?.executable === managed.executable ? "" : " (present, not resolved)"));
  lines.push(`upstream:   ${state.upstreamVersion ?? "not checked yet"}`);
  lines.push(`pin:        ${state.pin ?? "none"}`);
  lines.push(`agent dir:  ${agentDir(host)}`);
  const entry = await entryStatus(host, resolved?.executable ?? null);
  if (entry.problem !== undefined) {
    lines.push(`mcp entry:  unreadable -- ${entry.problem}`);
  } else if (!entry.present) {
    lines.push(`mcp entry:  absent from ${entry.path}`);
  } else {
    lines.push(`mcp entry:  ${entry.current ? "current" : `stale, names ${entry.command ?? "(no command)"}`} in ${entry.path}`);
  }
  return { lines, resolved };
}
async function install(lifecycle, version) {
  const { host } = lifecycle;
  let acquired;
  try {
    acquired = await acquire({
      host,
      target: lifecycle.target,
      source: lifecycle.source,
      ...version === undefined ? {} : { version: normalizeVersion(version) }
    });
  } catch (error) {
    return { ok: false, message: `install failed: ${describe(error)}` };
  }
  const state = await updateState(host, {
    managedVersion: acquired.version,
    managedDigest: acquired.digest,
    upstreamVersion: acquired.version,
    lastCheckedAt: Date.now()
  });
  const resolution = await resolveExecutable(host, state);
  if (!resolution.ok) {
    return {
      ok: false,
      message: `adopted ${acquired.version} at ${acquired.executable}, but resolution then found nothing: ${resolution.reason}`
    };
  }
  const wiring = await wire(lifecycle, resolution.resolved, state);
  const adopted = resolution.resolved.executable === acquired.executable ? `adopted ${acquired.version} (${acquired.reportedVersion}) at ${acquired.executable}` : `adopted ${acquired.version} at ${acquired.executable}, but resolution prefers ` + `${resolution.resolved.executable} (${resolution.resolved.source})`;
  return { ok: true, message: `${adopted}. ${wiring.message}` };
}
async function update(lifecycle) {
  const { host } = lifecycle;
  const state = await readState(host);
  const resolution = await resolveExecutable(host, state);
  if (resolution.ok && resolution.resolved.source === "system") {
    const check = await checkUpstream(lifecycle, { force: true });
    return {
      ok: true,
      message: `${resolution.resolved.executable} is a system installation this package adopted, so it is not replaced here. ` + `Run \`${resolution.resolved.executable} update\` to update it. ${check.message}`
    };
  }
  if (state.pin !== undefined) {
    const check = await checkUpstream(lifecycle, { force: true });
    return {
      ok: true,
      message: `version ${state.pin} is pinned, so nothing was adopted. ${check.message} Run /cbm unpin to release it.`
    };
  }
  return await install(lifecycle);
}
async function pin(lifecycle, version) {
  let normalized;
  try {
    normalized = normalizeVersion(version);
  } catch (error) {
    return { ok: false, message: `pin failed: ${describe(error)}` };
  }
  await updateState(lifecycle.host, { pin: normalized });
  const managed = await managedCopy(lifecycle.host);
  const note = managed?.version === normalized ? "It is already on disk, so resolution will prefer it." : `No managed copy of ${normalized} is on disk yet; run \`/cbm install ${normalized}\` to place one.`;
  return { ok: true, message: `pinned version ${normalized}. ${note}` };
}
async function unpin(lifecycle) {
  const state = await readState(lifecycle.host);
  if (state.pin === undefined)
    return { ok: true, message: "no version was pinned." };
  const { pin: _released, ...remaining } = state;
  await writeState(lifecycle.host, remaining);
  return { ok: true, message: `released the pin on version ${state.pin}.` };
}
async function uninstall(lifecycle) {
  const { host } = lifecycle;
  const state = await readState(host);
  const removal = await removeEntry(host, state.wroteCommand);
  const entryMessage = removal.ok ? removal.change === "removed" ? "removed the owned MCP entry" : "there was no owned MCP entry to remove" : `left the MCP entry alone: ${removal.reason}`;
  const root = packageRoot(host);
  const managed = await managedCopy(host, state);
  await rm2(root, { recursive: true, force: true });
  const copyMessage = managed === null ? "no managed copy was present" : `removed the managed copy of ${managed.version}`;
  const systemNote = await systemStillPresent(host);
  return { ok: true, message: `${copyMessage}, ${entryMessage}, and deleted ${root}.${systemNote}` };
}
async function syncEntry(lifecycle) {
  const { host } = lifecycle;
  const state = await readState(host);
  const resolution = await resolveExecutable(host, state);
  if (!resolution.ok) {
    return {
      kind: "unresolved",
      message: `${resolution.reason} No MCP entry was written or changed.`
    };
  }
  const before = await entryStatus(host, resolution.resolved.executable);
  const outcome = await wire(lifecycle, resolution.resolved, state);
  if (!outcome.ok)
    return { kind: "refused", message: outcome.message };
  if (!before.present)
    return { kind: "wired", message: outcome.message };
  return before.current ? { kind: "unchanged", message: outcome.message } : { kind: "rewired", message: outcome.message };
}
async function checkUpstream(lifecycle, options = {}) {
  const { host } = lifecycle;
  const now = options.now ?? Date.now();
  const state = await readState(host);
  const last = state.lastCheckedAt;
  if (options.force !== true && last !== undefined && now - last < CHECK_INTERVAL_MS) {
    return {
      kind: "skipped",
      message: `upstream was last checked ${Math.round((now - last) / 60000)} minutes ago; skipping.`
    };
  }
  let upstream;
  try {
    upstream = normalizeVersion(await lifecycle.source.latestTag());
  } catch (error) {
    await updateState(host, { lastCheckedAt: now });
    return { kind: "failed", message: `upstream version check failed: ${describe(error)}` };
  }
  const next = await updateState(host, { upstreamVersion: upstream, lastCheckedAt: now });
  const resolution = await resolveExecutable(host, next);
  const local = resolution.ok ? await resolvedVersion(resolution.resolved) : null;
  if (local !== null && local.includes(upstream)) {
    return { kind: "current", message: `upstream ${upstream} matches the local executable.` };
  }
  const remedy = !resolution.ok ? "Run /cbm install to place a managed copy." : next.pin !== undefined ? `Version ${next.pin} is pinned, so nothing will be adopted. Run /cbm unpin to release it.` : resolution.resolved.source === "system" ? `Run \`${resolution.resolved.executable} update\` to update the system installation.` : "Run /cbm update to adopt it.";
  return {
    kind: "newer",
    message: `upstream release is ${upstream}; local is ${local ?? "unknown"}. ${remedy}`
  };
}
async function wire(lifecycle, resolved, state) {
  const outcome = await upsertEntry(lifecycle.host, resolved.executable, state.wroteCommand);
  if (!outcome.ok)
    return { ok: false, message: outcome.reason };
  if (state.wroteCommand !== resolved.executable) {
    await updateState(lifecycle.host, { wroteCommand: resolved.executable });
  }
  switch (outcome.change) {
    case "created":
      return { ok: true, message: `Wrote the MCP entry naming ${resolved.executable}.` };
    case "updated":
      return {
        ok: true,
        message: `Corrected the MCP entry to ${resolved.executable}; run /mcp reload so this session picks it up.`
      };
    case "unchanged":
      return { ok: true, message: `The MCP entry already names ${resolved.executable}.` };
  }
}
async function systemStillPresent(host) {
  const resolution = await resolveExecutable(host, {});
  return resolution.ok && resolution.resolved.source === "system" ? ` The system installation at ${resolution.resolved.executable} was left in place.` : "";
}
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/index.ts
var CHECK_DELAY_MS = 20000;
var SUBCOMMANDS = [
  "status",
  "install",
  "update",
  "pin",
  "unpin",
  "uninstall"
];
function ompCodebaseMemory(pi) {
  const host = processHost();
  const native = nativeExtensionPath(host);
  if (existsSync(native)) {
    pi.logger.info("omp-codebase-memory: standing down", { native });
    return;
  }
  pi.setLabel("Codebase Memory");
  let lifecycle = null;
  let unsupported = null;
  try {
    lifecycle = { host, target: hostTarget(), source: githubReleaseSource() };
  } catch (error) {
    unsupported = error instanceof UnsupportedPlatformError ? error.message : `platform detection failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  const notified = new Set;
  const notifyOnce = (ctx, message, type) => {
    if (notified.has(message))
      return;
    notified.add(message);
    notify(ctx, message, type);
  };
  const notify = (ctx, message, type) => {
    try {
      ctx.ui.notify(message, type);
    } catch (error) {
      pi.logger.error("omp-codebase-memory: notification failed", {
        error: error instanceof Error ? error.message : String(error),
        message
      });
    }
  };
  const report = (ctx, outcome) => {
    notify(ctx, `/cbm: ${outcome.message}`, outcome.ok ? "info" : "error");
  };
  pi.registerCommand("cbm", {
    description: "codebase-memory-mcp lifecycle: status, install, update, pin, unpin, uninstall",
    getArgumentCompletions: (prefix) => {
      const matches = SUBCOMMANDS.filter((name) => name.startsWith(prefix.trimStart()));
      return matches.length === 0 ? null : matches.map((name) => ({ value: name, label: `/cbm ${name}` }));
    },
    handler: async (args, ctx) => {
      const [subcommand = "status", ...rest] = args.trim().split(/\s+/u).filter((part) => part !== "");
      if (lifecycle === null) {
        notify(ctx, `/cbm: ${unsupported ?? "unavailable on this platform"}`, "error");
        return;
      }
      switch (subcommand) {
        case "status": {
          const report_ = await status(lifecycle);
          notify(ctx, ["codebase-memory-mcp", ...report_.lines].join(`
`), "info");
          return;
        }
        case "install":
          report(ctx, await runInstall(ctx, lifecycle, rest[0]));
          return;
        case "update":
          report(ctx, await update(lifecycle));
          return;
        case "pin": {
          const version = rest[0];
          report(ctx, version === undefined ? { ok: false, message: "pin needs a version, e.g. `/cbm pin 0.10.8`." } : await pin(lifecycle, version));
          return;
        }
        case "unpin":
          report(ctx, await unpin(lifecycle));
          return;
        case "uninstall":
          report(ctx, await uninstall(lifecycle));
          return;
        default:
          notify(ctx, `/cbm: unknown subcommand \`${subcommand}\`. Use one of: ${SUBCOMMANDS.join(", ")}.`, "error");
      }
    }
  });
  const runInstall = async (ctx, active, version) => {
    const resolution = await resolveExecutable(active.host, await readState(active.host));
    const hazard = resolution.ok && resolution.resolved.source === "system" ? `${resolution.resolved.executable} already resolves (${resolution.resolved.origin}).` : null;
    if (hazard !== null) {
      const explanation = `${hazard} CBM resolves one canonical cache root per account and refuses to run when a ` + "process is configured with a different root while another CBM session is active, so a " + "second executable of a different version produces mismatched index generations. " + "Adopting the installation you already have is the safe default.";
      if (!ctx.hasUI) {
        return {
          ok: false,
          message: `${explanation} This session has no interactive UI, so the confirmation this needs cannot be asked; nothing was downloaded.`
        };
      }
      const confirmed = await ctx.ui.confirm("Install a second codebase-memory-mcp?", explanation);
      if (!confirmed)
        return { ok: true, message: `${explanation} Nothing was downloaded.` };
    }
    return await install(active, version);
  };
  pi.on("session_start", async (_event, ctx) => {
    if (lifecycle === null)
      return;
    const active = lifecycle;
    try {
      const sync = await syncEntry(active);
      switch (sync.kind) {
        case "rewired":
        case "wired":
          notifyOnce(ctx, `codebase-memory-mcp: ${sync.message}`, "info");
          break;
        case "unresolved":
        case "refused":
          notifyOnce(ctx, `codebase-memory-mcp: ${sync.message}`, "warning");
          break;
        case "unchanged":
          break;
      }
    } catch (error) {
      pi.logger.error("omp-codebase-memory: session start sync failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    const scheduler = schedulerFrom(ctx);
    scheduler.after(() => {
      checkUpstream(active).then((check) => {
        if (check.kind === "newer")
          notifyOnce(ctx, `codebase-memory-mcp: ${check.message}`, "info");
        else
          pi.logger.info("omp-codebase-memory: version check", { check: check.message });
      }).catch((error) => {
        pi.logger.info("omp-codebase-memory: version check failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }, CHECK_DELAY_MS);
  });
}
export {
  ompCodebaseMemory as default
};
