# Repository Guidelines

## Authority

`rasen/specs/` contains the accepted capability specifications and outranks
change proposals. `rasen/changes/` records design decisions and their rationale;
do not duplicate that rationale here.

When implementation changes a normative decision, update the affected
specification in the same change.

## Project boundaries

`omp-codebase-memory` distributes `codebase-memory-mcp` (CBM) as an installable
OMP extension. It is TypeScript on Bun, has no npm runtime dependencies, and
commits its bundled entry point at `dist/index.js`.

The following boundaries are fixed:

- Consume CBM release artifacts; contributing changes to
  `DeusData/codebase-memory-mcp` is out of scope.
- Adopt an existing `codebase-memory-mcp` on `PATH` and never replace it. Put a
  package-managed copy under a package-owned root outside the plugin tree. Never
  write `~/.local/bin` or modify an executable this package did not install.
- Own exactly the `codebase-memory-mcp` key under `mcpServers` in the active OMP
  agent directory's `mcp.json`. Upsert it idempotently, fail closed on an
  unparseable file or foreign `command`, and remove it only while it still
  matches the package-owned entry.
- Never create or modify an operator's OMP agent-directory `AGENTS.md` or
  `RULES.md`.
- Never register a `tool_call` handler. Augment successful output through
  `tool_result`, append rather than replace prior content, and fail open.
- Never use platform timer globals. Use the handler context's managed timers
  through `src/scheduler.ts`.
- Never set an account-wide CBM configuration key for the operator.
- Never duplicate an action already exposed through CBM's MCP tools, including
  indexing.
- Never hand-edit generated context artifacts; regenerate them from the CBM
  executable.

This package owns only the executable it downloaded and its MCP entry. CBM owns
the graph, indexing, watcher, cache root, and updates to a system installation.
Windows and changes to any other operator file are out of scope.

## Repository layout

The working tree contains two independent Git repositories:

- The outer repository tracks code and delivery, including `.github/`, `src/`,
  `test/`, `dist/`, `package.json`, and `.omp-plugin/`.
- `rasen/` tracks planning artifacts in its own repository and remote.

`rasen/` is ignored by the outer repository. Commit its work with
`git -C rasen`; never stage planning and implementation in the same repository.

## Git workflow

`main` and release tags are protected by the committed rulesets under
`.github/rulesets/`. Before implementation, create a short-lived topic branch
named `<type>/<short-slug>`.

Use Conventional Commits and land changes through pull requests. The ruleset
permits merge commits only; do not squash. Unresolved review threads block the
merge.

Treat the committed rulesets as authoritative. Change and reimport those files
rather than editing protection through the web interface.

## CI and release

Branch protection requires one status check named `ci`. It is the gate job in
`.github/workflows/ci.yml`, runs under `if: always()`, fails when it aggregates
no jobs, and accepts only successful dependencies.

- Update the gate's `needs` whenever a required runtime job changes. Do not add
  runtime job names to the ruleset.
- Keep `install-check` outside the gate because it cannot install a pull
  request's merge ref.
- Pin every external `uses:` to a full 40-character commit SHA followed by a
  version comment.
- Default to `permissions: contents: read`, use
  `persist-credentials: false`, and grant `contents: write` only to the release
  publish job.
- Do not apply `paths` filters to jobs required by the gate.
- Pin Bun and its matching `@types/bun` version exactly. Install with
  `--frozen-lockfile`.
- Run checks through package scripts and print toolchain versions with results.
- Do not add a Node job; Node is not a supported runtime.

`dist/index.js` is committed. CI must build from source and compare the result
byte-for-byte with that tracked bundle.

A release tag must match `package.json`'s version and both the version and source
ref in `.omp-plugin/marketplace.json`. Create releases only from verified tags.

## Testing and verification

Add deterministic tests for changed behavior. Cover the package boundaries
affected by the change: release selection and checksums, archive validation,
executable resolution, MCP-entry ownership, transport security, scheduler
behavior, and handler fail-open paths.

`test/unit` must not require a CBM executable or network access. Use recorded
fixtures under `test/fixtures` and helpers in `test/support`. `test/packaging`
may build and load the bundle and touch the filesystem. Checks that require a
real executable or network access belong in a separate job.

Report the commands and revision used for verification. State which relevant
checks were not run and why; never claim an unexecuted check passed.

## Documentation

`README.md` is operator-facing and must be created or rewritten through the
`readme-creator` skill and its quality checklist. If that skill is unavailable,
stop rather than editing the README by hand.

This file is the authority for repository guidance. `AGENTS.md` must remain a
tracked symbolic link to `CLAUDE.md`; do not create another copy of these rules.
