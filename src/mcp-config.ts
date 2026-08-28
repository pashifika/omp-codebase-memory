import { mkdir } from "node:fs/promises";
import path from "node:path";

import { mcpConfigPath, SERVER_NAME, type Host } from "./paths.ts";

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
 */
export async function readMcpFile(host: Host): Promise<ReadResult> {
  const file = mcpConfigPath(host);
  let text: string;
  try {
    text = await Bun.file(file).text();
  } catch {
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
 * state. It is what makes ownership decidable: an entry naming that value, or
 * naming the currently resolved executable, is this package's to update.
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
    const ours = currentCommand === command || currentCommand === previouslyWrote;
    if (!ours) {
      return {
        ok: false,
        reason:
          `${file.path} already defines ${SERVER_NAME} with command ${currentCommand ?? "(none)"}, ` +
          `which this package did not write. It was left untouched; the executable this package resolved is ${command}.`,
      };
    }
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

  const rendered = render(next, file);
  if (file.text === rendered) return { ok: true, change: "unchanged" };

  await mkdir(path.dirname(file.path), { recursive: true });
  await Bun.write(file.path, rendered);
  return { ok: true, change: file.text === null ? "created" : "updated" };
}

/**
 * Removes the owned entry, and only when it still names what was written.
 *
 * The file itself stays in place whenever anything else remains in it -- other
 * servers, a `disabledServers` list, an `$schema` line. Deleting a file this
 * package did not create in order to take back one key would remove
 * configuration it never owned.
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
  if (wroteCommand === undefined || currentCommand !== wroteCommand) {
    return {
      ok: false,
      reason:
        `${file.path} defines ${SERVER_NAME} with command ${currentCommand ?? "(none)"}, ` +
        `which is not what this package wrote (${wroteCommand ?? "nothing recorded"}). It was left in place.`,
    };
  }

  const remaining: Record<string, unknown> = { ...servers };
  delete remaining[SERVER_NAME];

  const next: Record<string, unknown> = { ...file.document, mcpServers: remaining };
  await Bun.write(file.path, render(next, file));
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

/** The `mcpServers` map, or an empty one when the file has no usable map. */
function serverMap(document: Record<string, unknown>): Record<string, unknown> {
  const servers = document["mcpServers"];
  return typeof servers === "object" && servers !== null && !Array.isArray(servers)
    ? (servers as Record<string, unknown>)
    : {};
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
