# omp-codebase-memory

An [OMP](https://github.com/can1357/oh-my-pi) extension that owns the
[`codebase-memory-mcp`](https://github.com/DeusData/codebase-memory-mcp) (CBM)
executable's lifecycle and wires exactly one MCP server entry into OMP's native
user configuration.

CBM indexes a repository into a persistent code knowledge graph and exposes it
over MCP. Its own installer configures 44 client surfaces, and OMP is not one of
them: OMP only sees CBM indirectly, by discovering a Claude, Codex, or Gemini
config that some *other* client's installation happened to leave behind. An
OMP-only machine gets nothing.

This package is the missing path. `omp plugin install` is the whole setup step.

## What it does

- **Resolves the executable, system installation first.** An existing
  `codebase-memory-mcp` is adopted as-is and never replaced. A managed copy is
  downloaded only when none is found.
- **Verifies a download the way upstream's installer does.** Release tag from
  the `releases/latest` redirect, `checksums.txt` digest match for the exact
  archive name, HTTPS on every redirect hop, a closed four-member archive
  namespace, regular-file-not-symlink extraction, the Linux `-portable` build,
  macOS quarantine removal and ad-hoc signing, and a `--version` smoke run
  before anything is adopted.
- **Owns one key in `~/.omp/agent/mcp.json`.** `codebase-memory-mcp`, written
  with the resolved absolute path, corrected when that path changes, removed on
  uninstall. No other user file is touched.
- **Tracks versions without fighting CBM's own updater.** A managed copy is
  updated by this package. An adopted system copy is only reported on.

## Install

### Git spec (primary)

```sh
omp plugin install github:pashifika/omp-codebase-memory
```

CI runs this command, through OMP's own installer, on pushes to `main`, on
release tag pushes, and on manual dispatch — as
`github:pashifika/omp-codebase-memory#<ref>`, into a home directory with no
prior plugin state. `omp plugin install` validates what it installed by loading
the declared extension entry, so a ref that installs green also registers green.

### Marketplace

```sh
omp plugin marketplace add github:pashifika/omp-codebase-memory
omp plugin install omp-codebase-memory@omp-codebase-memory
```

The catalog lives at `.omp-plugin/marketplace.json`. Marketplace installs are
discovered through a different provider than git installs, so this is an
additional entry point rather than a replacement.

### Development

```sh
git clone https://github.com/pashifika/omp-codebase-memory
cd omp-codebase-memory
bun install
omp plugin link .
```

`omp.extensions` names `./dist/index.js`, which is committed, so a fresh clone
loads without a build step. Run `bun run build` after changing anything under
`src/`; CI fails if the committed bundle is not byte-identical to one built from
the current source.

CI links its own checkout with this command, so the development install is
verified to be discovered. That the committed bundle then *loads* through OMP's
loader is `test/packaging/bundle.test.ts` — `omp plugin link` registers a
checkout without loading it.

## Commands

| Command | What it does |
|---|---|
| `/cbm status` | Resolved source, absolute path, local version, last known upstream version, pin state, resolved agent directory, and whether the MCP entry is present and current |
| `/cbm install [version]` | Downloads, verifies, and adopts a managed copy. Asks for confirmation first when a system executable already resolves |
| `/cbm update` | Updates a managed copy. For an adopted system copy, reports the newer version and points at CBM's own `update` |
| `/cbm pin <version>` | Holds a version: update checks report but never adopt |
| `/cbm unpin` | Releases the pin |
| `/cbm uninstall` | Removes the managed copy, this package's state, and the owned MCP entry. Leaves an adopted system executable alone |

No command needs an interactive terminal. In a session with no UI, `/cbm
install` fails with the reason rather than waiting for a confirmation that
cannot arrive.

## The system-first policy, and why it is not negotiable

Resolution order is **pin, `PATH`, `~/.local/bin`, managed copy** — system
before managed.

CBM resolves one canonical per-account cache root, and refuses to run when a
process is configured with a different root while any CBM session or command is
active. Two executables of *different versions* sharing that root produce
mismatched index generations. Giving a managed copy its own private cache root
would avoid the conflict by re-indexing every repository a second time, which
for a large tree is hours of work and gigabytes to hold the same answers twice.

So the operator's existing installation wins. The cost is that this package
cannot guarantee a version, and that cost is made visible rather than hidden:
`/cbm status` names the source, and an out-of-date system copy produces a
pointer to CBM's own `update` rather than an attempt to perform it.

`/cbm install` while a system copy resolves is still possible — it is your
machine — but it explains the shared-cache-root consequence and requires
explicit confirmation first.

## Where things live

| Path | Owner | Notes |
|---|---|---|
| `~/.omp/codebase-memory/bin/<version>/` | this package | Managed executables, one directory per version |
| `~/.omp/codebase-memory/state.json` | this package | Version pointer, digest, pin, last check time |
| `<agent-dir>/mcp.json` | the operator | This package owns the single `codebase-memory-mcp` key and nothing else |
| `~/.local/bin/codebase-memory-mcp` | CBM's installer | Read during resolution, **never** written |

`<agent-dir>` is resolved the way OMP resolves it: `PI_CODING_AGENT_DIR` when
set, otherwise `~/.omp/profiles/<name>/agent` under `OMP_PROFILE`/`PI_PROFILE`,
otherwise `~/.omp/agent`. A profile-scoped operator therefore gets the entry
only in the active profile — writing every profile would configure profiles you
never asked about — and `/cbm status` names the directory it resolved so the
scope is visible.

The managed copy lives outside the plugin tree on purpose. OMP caches plugins in
version-qualified directories and replaces them on reinstall, so an executable
stored inside would be discarded by a routine plugin upgrade and re-downloaded
every time.

## Rollback

Two steps, in either order:

```sh
/cbm uninstall          # managed copy, state, and the owned MCP entry
omp plugin uninstall omp-codebase-memory
```

Neither touches an adopted system executable, CBM's cache, or any other client's
configuration.

## Requirements

- **Bun**, which is OMP's runtime. No npm runtime dependencies.
- **`tar`** for archive extraction.
- **`xattr` and `codesign`** on macOS. Both ship with a default install; their
  absence is reported as a named prerequisite rather than a mysterious failure.
- macOS and Linux. Windows is deferred, not refused: it needs zip extraction, a
  different executable suffix, and its own path handling, and is currently one
  explicit unsupported-platform error rather than a half-implemented branch.

## Known limits

- **MCP does not pick up a changed `command` without a reload.** A managed
  update changes the resolved path mid-session; the entry is corrected
  immediately and you are told the session needs `/mcp reload`.
- **A foreign entry of the same name is left alone.** If `mcp.json` already
  defines `codebase-memory-mcp` with a `command` this package did not write, the
  file is not modified and both paths are reported. CBM's own installer, another
  tool, or a hand edit may already own that name.
- **`~/.omp/agent/mcp.json` has two possible writers.** OMP's own `/mcp add` and
  this package have no shared lock. The write is a read-modify-write against the
  observed content and fails closed on a shape it does not recognise, so a lost
  update degrades to "the entry is missing and the next session start rewrites
  it" rather than a corrupted file.

## Development

```sh
bun install                # --frozen-lockfile in CI
bun run typecheck
bun run test:unit
bun run test:packaging     # rebuilds dist/index.js, then loads it
bun run build              # commit the result
```

Tests are written as case tables: one row per case, named by a `scenario` field,
so a failure names the case without anyone reading the table.

## Licence

MIT. See [LICENSE](./LICENSE).
