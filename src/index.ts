import { existsSync } from "node:fs";

import { openGraphClient } from "./graph.ts";
import { hostTarget, UnsupportedPlatformError } from "./platform.ts";
import { nativeExtensionPath, processHost } from "./paths.ts";
import { projectResolver } from "./project.ts";
import { githubReleaseSource } from "./release.ts";
import { resolvedVersion, resolveExecutable } from "./resolve.ts";
import { schedulerFrom } from "./scheduler.ts";
import { readState } from "./state.ts";
import { checkToolSurface } from "./tools.ts";
import {
  checkUpstream,
  confirmedInstall,
  pin,
  status,
  syncEntry,
  uninstall,
  unpin,
  update,
  type ActionReport,
  type Confirmer,
  type IndexProbe,
  type Lifecycle,
} from "./lifecycle.ts";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";

/**
 * The extension entry: registration only, and deliberately narrow.
 *
 * Two things are absent on purpose.
 *
 * There is no `tool_call` handler, and there is now a tool handler beside that
 * statement rather than instead of it. OMP treats a throwing or blocking
 * `tool_call` handler as a refusal of the tool call, so a context provider
 * registered there could deny an operator's `grep` because a subprocess timed
 * out. `tool_result` is the inverse: middleware-style, explicitly allowed to
 * replace a successful call's content, and a handler that throws is caught and
 * reported while the run continues. The graph augmentation therefore lives on
 * `tool_result` -- in its own entry, `dist/augment.js`, because feature gating
 * applies to manifest-declared entries and an extension cannot ask which of its
 * own features the operator selected. Neither entry registers `tool_call` under
 * any condition.
 *
 * There is no runtime action called during load. OMP wires those after the
 * factory returns, and calling one here throws
 * `ExtensionRuntimeNotInitializedError`.
 */

/**
 * How long after session start the version check runs.
 *
 * Off the blocking path by construction: session start returns, and the check
 * happens later on a managed timer. Long enough that a session doing real work
 * in its first seconds is not competing with a network request.
 */
const CHECK_DELAY_MS = 20_000;

/** The subcommands `/cbm` accepts, for the help text and for completions. */
const SUBCOMMANDS = [
  "status",
  "install",
  "update",
  "pin",
  "unpin",
  "uninstall",
] as const;

export default function ompCodebaseMemory(pi: ExtensionAPI): void {
  const host = processHost();

  // A future upstream `--clients=omp` would write its own native extension to
  // this path. Extension modules are deduplicated by absolute path, so both
  // would load and a later change's output augmentation would be applied twice.
  // Cheap to check now; impossible to retrofit once the duplicate is in the
  // field.
  const native = nativeExtensionPath(host);
  if (existsSync(native)) {
    pi.logger.info("omp-codebase-memory: standing down", { native });
    return;
  }

  pi.setLabel("Codebase Memory");

  /**
   * The lifecycle, or the reason there is none.
   *
   * Platform detection is the one thing that can fail before any command runs,
   * and it must not fail the load: an unsupported platform is a reason to
   * report on demand, not a reason for the extension to error out of a session
   * it could otherwise leave alone.
   */
  let lifecycle: Lifecycle | null = null;
  let unsupported: string | null = null;
  try {
    lifecycle = { host, target: hostTarget(), source: githubReleaseSource() };
  } catch (error) {
    unsupported =
      error instanceof UnsupportedPlatformError
        ? error.message
        : `platform detection failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  /** Messages already shown in this session, so a repeat is not shown again. */
  const notified = new Set<string>();

  const notifyOnce = (
    ctx: ExtensionContext,
    message: string,
    type: "info" | "warning" | "error",
  ): void => {
    if (notified.has(message)) return;
    notified.add(message);
    notify(ctx, message, type);
  };

  /**
   * Every notification goes through here.
   *
   * A UI failure is this package's problem, not the operator's: an overlay that
   * cannot render must not turn a successful lifecycle action into a thrown
   * error, and on `session_start` it must not surface as a failed handler.
   */
  const notify = (ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void => {
    try {
      ctx.ui.notify(message, type);
    } catch (error) {
      pi.logger.error("omp-codebase-memory: notification failed", {
        error: error instanceof Error ? error.message : String(error),
        message,
      });
    }
  };

  /** Reports an action, or the reason no action is possible on this platform. */
  const report = (ctx: ExtensionContext, outcome: ActionReport): void => {
    notify(ctx, `/cbm: ${outcome.message}`, outcome.ok ? "info" : "error");
  };

  /**
   * Where a graph failure is recorded.
   *
   * Debug log only, deliberately: a graph query that did not answer is not
   * something the operator asked for, and reporting it per attempt would turn a
   * best-effort addition into a source of noise.
   */
  const debug = (message: string): void => {
    pi.logger.info("omp-codebase-memory: graph", { message });
  };

  /**
   * Asks the graph which project covers `cwd`, over a session of its own.
   *
   * Opened and closed around the one question, because this runs for an
   * explicit `/cbm status` rather than continuously: the operator typed the
   * command and a short-lived CBM process is the honest cost of answering it.
   * The resolution goes through `projectResolver`, so status and the
   * augmentation cannot name different projects for one directory.
   */
  const indexProbe = (cwd: string): IndexProbe => {
    return async (executable) => {
      const client = openGraphClient(executable, { onDebug: debug });
      try {
        return await projectResolver(client, cwd).resolve();
      } finally {
        client.close();
      }
    };
  };

  pi.registerCommand("cbm", {
    description: "codebase-memory-mcp lifecycle: status, install, update, pin, unpin, uninstall",
    getArgumentCompletions: (prefix) => {
      const matches = SUBCOMMANDS.filter((name) => name.startsWith(prefix.trimStart()));
      return matches.length === 0
        ? null
        : matches.map((name) => ({ value: name, label: `/cbm ${name}` }));
    },
    handler: async (args, ctx) => {
      const [subcommand = "status", ...rest] = args.trim().split(/\s+/u).filter((part) => part !== "");

      if (lifecycle === null) {
        notify(ctx, `/cbm: ${unsupported ?? "unavailable on this platform"}`, "error");
        return;
      }

      switch (subcommand) {
        case "status": {
          const report_ = await status(lifecycle, indexProbe(ctx.cwd));
          notify(ctx, ["codebase-memory-mcp", ...report_.lines].join("\n"), "info");
          return;
        }
        case "install":
          report(ctx, await confirmedInstall(lifecycle, rest[0], confirmerFrom(ctx)));
          return;
        case "update":
          report(ctx, await update(lifecycle));
          return;
        case "pin": {
          const version = rest[0];
          report(
            ctx,
            version === undefined
              ? { ok: false, message: "pin needs a version, e.g. `/cbm pin 0.10.8`." }
              : await pin(lifecycle, version),
          );
          return;
        }
        case "unpin":
          report(ctx, await unpin(lifecycle));
          return;
        case "uninstall":
          report(ctx, await uninstall(lifecycle));
          return;
        default:
          notify(
            ctx,
            `/cbm: unknown subcommand \`${subcommand}\`. Use one of: ${SUBCOMMANDS.join(", ")}.`,
            "error",
          );
      }
    },
  });

  /**
   * Adapts one command context to the lifecycle's confirmation seam.
   *
   * The decision that needs the answer -- whether a second executable is a
   * hazard, what to tell the operator, and what to do when no UI exists -- lives
   * in `confirmedInstall`, where a test can reach it. This is the whole of the
   * translation.
   */
  const confirmerFrom = (ctx: ExtensionCommandContext): Confirmer => ({
    available: ctx.hasUI,
    ask: (title, message) => ctx.ui.confirm(title, message),
  });

  /**
   * Whether the executable still has the tools the shipped guidance names.
   *
   * The primary drift detector, and it runs on the operator's own machine
   * against the executable they actually have: the scheduled CI job cannot see
   * a newer CBM on someone else's laptop, and GitHub disables a dormant
   * repository's schedule silently. At most one notice, and a failed query is a
   * debug line and nothing else.
   */
  const driftCheck = async (active: Lifecycle, ctx: ExtensionContext): Promise<void> => {
    const resolution = await resolveExecutable(active.host, await readState(active.host));
    if (!resolution.ok) return;
    const version = (await resolvedVersion(resolution.resolved)) ?? resolution.resolved.executable;

    const client = openGraphClient(resolution.resolved.executable, { onDebug: debug });
    try {
      const notice = await checkToolSurface(client, version, { onDebug: debug });
      if (notice !== null) notifyOnce(ctx, `codebase-memory-mcp: ${notice}`, "warning");
    } finally {
      client.close();
    }
  };

  /**
   * Session start: verify the owned entry, correct it, and never block.
   *
   * The version check and the tool-surface check are deferred onto one managed
   * timer rather than awaited here, because a session must start at the speed of
   * the filesystem and not at the speed of the network. One timer, and the two
   * run in sequence inside it, so a session never has two CBM subprocesses of
   * this package's making alive at once.
   */
  pi.on("session_start", async (_event, ctx) => {
    if (lifecycle === null) return;
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
      // Session start is not the place to fail. Anything unexpected here is
      // recorded and the session continues without a corrected entry.
      pi.logger.error("omp-codebase-memory: session start sync failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const scheduler = schedulerFrom(ctx);
    scheduler.after(() => {
      void checkUpstream(active)
        .then((check) => {
          if (check.kind === "newer") notifyOnce(ctx, `codebase-memory-mcp: ${check.message}`, "info");
          else pi.logger.info("omp-codebase-memory: version check", { check: check.message });
        })
        .catch((error: unknown) => {
          // Debug log only: a failed check must not reach the operator, and
          // must not reach the session's error channel either.
          pi.logger.info("omp-codebase-memory: version check failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .then(async () => await driftCheck(active, ctx))
        .catch((error: unknown) => {
          pi.logger.info("omp-codebase-memory: tool-surface check failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }, CHECK_DELAY_MS);
  });
}
