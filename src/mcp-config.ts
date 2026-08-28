import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { insideManagedBinRoot, mcpConfigPath, SERVER_NAME, type Host } from "./paths.ts";

/**
 * Sole ownership of one key in OMP's native user MCP configuration.
 *
 * This is the only operator file this package writes, and the write is
 * constrained accordingly: one key, idempotent, siblings and formatting
 * preserved, fail closed on a `command` value this package did not write, and
 * removal only when the value still matches.
 *
 * It has to be the native file rather than a plugin-root `.mcp.json`. The entry
 * must name an absolute path to a home-relative or package-owned executable,
 * and a plugin-root MCP file gets no `${VAR}` expansion while `command` gets no
 * pre-connect environment resolution at all -- so a committed file cannot
 * express the path, and requiring the executable on `PATH` would defeat the
 * system-first policy's own fallback. The native file can carry the absolute
 * path, and sits at MCP discovery priority 1 so its entry always wins.
 */

/** The `$schema` OMP writes into its own managed MCP files. */
export const MCP_SCHEMA_URL =
  "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";

/** What one read of the file established. */
export interface McpFile {
  readonly path: string;
  /** Raw text, or `null` when the file does not exist. */
  readonly text: string | null;
  /** Parsed document; an empty object when the file does not exist. */
  readonly document: Record<string, unknown>;
  /** Indentation the file already used, reproduced on write. */
  readonly indent: string;
  /** Whether the file ended with a newline, reproduced on write. */
  readonly trailingNewline: boolean;
}

export type ReadResult =
  | { readonly ok: true; readonly file: McpFile }
  /** A structural refusal: the file exists but cannot be parsed. */
  | { readonly ok: false; readonly reason: string };

/** What one write attempt did, or refused to do. */
export type WriteOutcome =
  | { readonly ok: true; readonly change: "created" | "updated" | "unchanged" }
  | { readonly ok: false; readonly reason: string };

/** What one removal attempt did, or refused to do. */
export type RemoveOutcome =
  | { readonly ok: true; readonly change: "removed" | "absent" }
  | { readonly ok: false; readonly reason: string };

/** What the file currently says about the owned entry. */
export interface EntryStatus {
  readonly path: string;
  /** Whether an entry under this package's key exists at all. */
  readonly present: boolean;
  /** The `command` that entry names, when present. */
  readonly command?: string;
  /** Whether that command equals the currently resolved executable. */
  readonly current: boolean;
  /** Set when the file could not be read structurally. */
  readonly problem?: string;
}

/**
 * Reads the file for a read-modify-write.
 *
 * A missing file is not a problem -- it is the first-run case, and the write
 * creates it. An unparseable file is refused rather than replaced: a hand edit
 * in progress, or another writer's partial write, is not something to resolve
 * by discarding the operator's content.
 *
 * A file that exists and cannot be read is refused for the same reason. Only
 * `ENOENT` and `ENOTDIR` mean "there is no file here"; every other errno --
 * `EACCES` after a `sudo omp`, `EISDIR`, an I/O error -- means the content is
 * unknown, and reporting that as an absent entry would tell the operator the
 * entry is missing from a file this package could not open, and then write a
 * fresh document over whatever was in it.
 */
export async function readMcpFile(host: Host): Promise<ReadResult> {
  const file = mcpConfigPath(host);
  let text: string;
  try {
    text = await Bun.file(file).text();
  } catch (error) {
    const code = (error as { code?: string } | null | undefined)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      return {
        ok: false,
        reason:
          `${file} could not be read (${code ?? "no errno"}), so it was left untouched: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return {
      ok: true,
      file: { path: file, text: null, document: {}, indent: "  ", trailingNewline: true },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      reason: `${file} is not parseable JSON, so it was left untouched: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: `${file} does not hold a JSON object, so it was left untouched` };
  }

  // Refused rather than replaced by an empty map, which is the one malformed
  // shape this reader used to recognise by discarding: the write below spreads
  // the map it is given, so an `mcpServers` array or scalar would be silently
  // deleted by the code path whose entire purpose is refusing to overwrite
  // operator content.
  const servers = (parsed as Record<string, unknown>)["mcpServers"];
  const shaped = typeof servers === "object" && servers !== null && !Array.isArray(servers);
  if (servers !== undefined && !shaped) {
    return {
      ok: false,
      reason: `${file} holds an mcpServers value that is not a JSON object, so it was left untouched`,
    };
  }

  return {
    ok: true,
    file: {
      path: file,
      text,
      document: parsed as Record<string, unknown>,
      indent: detectIndent(text),
      trailingNewline: text.endsWith("\n"),
    },
  };
}

/**
 * Upserts the owned entry so it names `command`.
 *
 * `previouslyWrote` is the `command` this package last wrote, from its own
 * state. It is one of the two things that make ownership decidable: an entry
 * naming that value, or naming the currently resolved executable, is this
 * package's to update. The other is the path itself -- an entry whose `command`
 * is inside this package's own managed bin root can only have been written by
 * this package, and deciding on state alone would report it as somebody else's
 * whenever the state file was lost, which is the one case the self-correcting
 * session-start check exists for.
 *
 * Anything else belongs to CBM's own installer, another tool, or a hand edit,
 * and is left alone with both paths reported -- silently replacing it would
 * discard a working configuration and hide that two owners exist.
 */
export async function upsertEntry(
  host: Host,
  command: string,
  previouslyWrote: string | undefined,
): Promise<WriteOutcome> {
  const read = await readMcpFile(host);
  if (!read.ok) return read;

  const { file } = read;
  const servers = serverMap(file.document);
  const existing = servers[SERVER_NAME];

  if (existing !== undefined) {
    const currentCommand = commandOf(existing);
    const ours =
      currentCommand === command ||
      currentCommand === previouslyWrote ||
      (currentCommand !== undefined && insideManagedBinRoot(host, currentCommand));
    if (!ours) {
      return {
        ok: false,
        reason:
          `${file.path} already defines ${SERVER_NAME} with command ${currentCommand ?? "(none)"}, ` +
          `which this package did not write. It was left untouched; the executable this package resolved is ${command}.`,
      };
    }

    // The no-op is decided on the parsed entry, never on re-rendered bytes: a
    // file this package did not format -- compact, CRLF, mixed indentation --
    // never equals its own rendering, so comparing bytes would reformat the
    // operator's file on a run that had nothing to change, and expose it to a
    // needless write.
    if (isCurrentEntry(existing, command)) return { ok: true, change: "unchanged" };
  }

  const next: Record<string, unknown> = { ...file.document };
  if (file.text === null) next["$schema"] = MCP_SCHEMA_URL;

  // The `command` is the only field replaced on an update. Every other field an
  // operator added to the entry -- a `timeout`, an `env` -- is theirs to keep.
  const entry: Record<string, unknown> = {
    ...(typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {}),
    type: "stdio",
    command,
    args: [],
  };
  next["mcpServers"] = { ...servers, [SERVER_NAME]: entry };

  await mkdir(path.dirname(file.path), { recursive: true });
  await writeDurably(file.path, render(next, file));
  return { ok: true, change: file.text === null ? "created" : "updated" };
}

/**
 * Removes the owned entry, and only when it is still decidably this package's.
 *
 * Ownership is the same two-sided test the upsert uses: the recorded write, or
 * a `command` inside this package's own managed bin root. Deciding on the
 * recorded write alone made an entry naming a path only this package writes
 * permanently unreclaimable once the state file was gone.
 *
 * The file itself stays in place whenever anything else remains in it -- other
 * servers, a `disabledServers` list, an `$schema` value this package did not
 * write. Deleting a file this package did not create in order to take back one
 * key would remove configuration it never owned.
 */
export async function removeEntry(
  host: Host,
  wroteCommand: string | undefined,
): Promise<RemoveOutcome> {
  const read = await readMcpFile(host);
  if (!read.ok) return read;

  const { file } = read;
  if (file.text === null) return { ok: true, change: "absent" };

  const servers = serverMap(file.document);
  const existing = servers[SERVER_NAME];
  if (existing === undefined) return { ok: true, change: "absent" };

  const currentCommand = commandOf(existing);
  const ours =
    (wroteCommand !== undefined && currentCommand === wroteCommand) ||
    (currentCommand !== undefined && insideManagedBinRoot(host, currentCommand));
  if (!ours) {
    return {
      ok: false,
      reason:
        `${file.path} defines ${SERVER_NAME} with command ${currentCommand ?? "(none)"}, ` +
        `which is not what this package wrote (${wroteCommand ?? "nothing recorded"}). It was left in place.`,
    };
  }

  const remaining: Record<string, unknown> = { ...servers };
  delete remaining[SERVER_NAME];

  // A file whose only other key is the `$schema` this package writes on create
  // is a file this package created, so taking back its last key means removing
  // it: rolling back is supposed to return the machine to its pre-install state,
  // and an empty `{"mcpServers": {}}` the operator never had is not that.
  const others = Object.keys(file.document).filter((key) => key !== "mcpServers");
  const ourCreation =
    others.length === 1 && others[0] === "$schema" && file.document["$schema"] === MCP_SCHEMA_URL;
  if (Object.keys(remaining).length === 0 && ourCreation) {
    await rm(file.path, { force: true });
    return { ok: true, change: "removed" };
  }

  const next: Record<string, unknown> = { ...file.document, mcpServers: remaining };
  await writeDurably(file.path, render(next, file));
  return { ok: true, change: "removed" };
}

/** What the file says about the owned entry, without writing anything. */
export async function entryStatus(host: Host, resolvedCommand: string | null): Promise<EntryStatus> {
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
    ...(command === undefined ? {} : { command }),
    current: command !== undefined && command === resolvedCommand,
  };
}

/**
 * The `mcpServers` map, or an empty one when the file has none.
 *
 * The shape check is what narrows the type; {@link readMcpFile} has already
 * refused every value but a map and `undefined`, so the fallback is only the
 * missing key.
 */
function serverMap(document: Record<string, unknown>): Record<string, unknown> {
  const servers = document["mcpServers"];
  return typeof servers === "object" && servers !== null && !Array.isArray(servers)
    ? (servers as Record<string, unknown>)
    : {};
}

/** Whether the existing entry already says exactly what a write would say. */
function isCurrentEntry(entry: unknown, command: string): boolean {
  if (commandOf(entry) !== command) return false;
  const record = entry as Record<string, unknown>;
  const args = record["args"];
  return record["type"] === "stdio" && Array.isArray(args) && args.length === 0;
}

/** The `command` an entry names, when it names a usable one. */
function commandOf(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  const command = (entry as Record<string, unknown>)["command"];
  return typeof command === "string" ? command : undefined;
}

/**
 * The file's own indentation, so a rewrite does not reformat it.
 *
 * JSON cannot carry comments and `JSON.parse` discards whitespace, so
 * indentation is as much of the operator's formatting as this package can
 * preserve. A two-space file -- which is what OMP's own writer produces -- comes
 * back byte-identical apart from the key that changed.
 */
function detectIndent(text: string): string {
  const match = /\n([ \t]+)"/u.exec(text);
  return match?.[1] ?? "  ";
}

function render(document: Record<string, unknown>, file: McpFile): string {
  const body = JSON.stringify(document, null, file.indent);
  return file.trailingNewline ? `${body}\n` : body;
}

/**
 * Replaces `file` by staging the new content beside it and renaming it in.
 *
 * `Bun.write` to an existing path truncates it in place, so an interrupted
 * write -- a crash, a `SIGKILL` at shutdown, `ENOSPC` -- leaves a half-written
 * document. OMP reads this file with a bare `JSON.parse` and drops the whole
 * document when it fails, so that window costs the operator every user-level
 * MCP server with no warning, and this package then refuses the file forever as
 * unparseable. `rename` within one directory is atomic: a reader sees either
 * the old document or the new one.
 *
 * The staging name carries the pid and a random suffix so two concurrent
 * writers never share it, which is what OMP's own writer does for the same
 * file. It is removed on failure so a failed write leaves nothing behind.
 *
 * The destination's own mode is reproduced before the rename, because `rename`
 * replaces the destination rather than truncating it: the visible file would
 * otherwise inherit the staging file's default, which is 0644 under the usual
 * umask. This file can carry per-server `env` secrets, remote `headers` and an
 * `auth.clientSecret`, and OMP's own writer creates it 0600 -- so any file last
 * written by `/mcp add|enable|disable` is 0600 on disk, and publishing it 0644
 * would be a disclosure. A mode the operator widened deliberately is reproduced
 * too, not narrowed; only a file this write creates gets 0600 by default.
 */
async function writeDurably(file: string, contents: string): Promise<void> {
  const staging = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    let mode = 0o600;
    try {
      mode = (await stat(file)).mode & 0o777;
    } catch (error) {
      const code = (error as { code?: string } | null | undefined)?.code;
      if (code !== "ENOENT") throw error;
    }

    await Bun.write(staging, contents);
    await chmod(staging, mode);
    await rename(staging, file);
  } catch (error) {
    await rm(staging, { force: true });
    throw error;
  }
}
