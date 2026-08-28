import { existsSync } from "node:fs";

import { hostTarget, UnsupportedPlatformError } from "./platform.ts";
import { nativeExtensionPath, processHost } from "./paths.ts";
import { githubReleaseSource } from "./release.ts";
import { resolveExecutable } from "./resolve.ts";
import { readState } from "./state.ts";
import { schedulerFrom } from "./scheduler.ts";
import {
  checkUpstream,
  install,
  pin,
  status,
  syncEntry,
  uninstall,
  unpin,
  update,
  type ActionReport,
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
 * There is no `tool_call` handler. OMP treats a throwing or blocking
 * `tool_call` handler as a refusal of the tool call, so a context provider
 * registered there could deny an operator's `grep` because a subprocess timed
 * out. A provider that adds nothing is better than one that can take something
 * away, so the event is not registered at all -- and the output augmentation a
 * later change adds belongs on `tool_result`, which is documented as
 * middleware-style and explicitly allowed to replace content.
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
          const report_ = await status(lifecycle);
          notify(ctx, ["codebase-memory-mcp", ...report_.lines].join("\n"), "info");
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
   * Acquires a managed copy, with the shared-cache-root hazard made explicit.
   *
   * The confirmation is not a formality. CBM resolves one canonical per-account
   * cache root and refuses to run when a process is configured with a different
   * root while any CBM session or command is active, so two executables of
   * different versions produce mismatched index generations. An operator who
   * already has a working installation should be told that before a second one
   * exists, not after.
   *
   * With no interactive UI the command fails with that reason rather than
   * waiting: nothing here may block on input that cannot arrive.
   */
  const runInstall = async (
    ctx: ExtensionCommandContext,
    active: Lifecycle,
    version: string | undefined,
  ): Promise<ActionReport> => {
    const resolution = await resolveExecutable(active.host, await readState(active.host));
    const hazard =
      resolution.ok && resolution.resolved.source === "system"
        ? `${resolution.resolved.executable} already resolves (${resolution.resolved.origin}).`
        : null;

    if (hazard !== null) {
      const explanation =
        `${hazard} CBM resolves one canonical cache root per account and refuses to run when a ` +
        "process is configured with a different root while another CBM session is active, so a " +
        "second executable of a different version produces mismatched index generations. " +
        "Adopting the installation you already have is the safe default.";

      if (!ctx.hasUI) {
        return {
          ok: false,
          message: `${explanation} This session has no interactive UI, so the confirmation this needs cannot be asked; nothing was downloaded.`,
        };
      }

      const confirmed = await ctx.ui.confirm("Install a second codebase-memory-mcp?", explanation);
      if (!confirmed) return { ok: true, message: `${explanation} Nothing was downloaded.` };
    }

    return await install(active, version);
  };

  /**
   * Session start: verify the owned entry, correct it, and never block.
   *
   * The version check is deferred onto a managed timer rather than awaited
   * here, because a session must start at the speed of the filesystem and not
   * at the speed of the network.
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
        });
    }, CHECK_DELAY_MS);
  });
}
