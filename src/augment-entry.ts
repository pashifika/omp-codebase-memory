import { existsSync } from "node:fs";

import { createAugmenter } from "./augment.ts";
import { openGraphClient } from "./graph.ts";
import { nativeExtensionPath, processHost } from "./paths.ts";
import { resolveExecutable } from "./resolve.ts";
import { schedulerFrom } from "./scheduler.ts";
import { readState } from "./state.ts";

import type { Augmenter } from "./augment.ts";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/**
 * The augmentation feature's own extension entry.
 *
 * Separate from `dist/index.js` because that is what makes the feature gate
 * real. OMP collects `manifest.extensions` always and a feature's `extensions`
 * only while that feature is enabled, and an extension has no way to ask which
 * of its own features the operator selected -- so "registered only when the
 * feature is active" has to be a property of which file gets loaded, not of a
 * runtime check.
 *
 * Registers `session_start`, `tool_result`, and `session_shutdown`, and never
 * `tool_call`: a throwing or blocking `tool_call` handler is a refusal of the
 * tool call, so a graph query that stalled could deny the operator's `grep`.
 */
/**
 * How long after session start the graph session is opened.
 *
 * Zero, and still on the scheduler: the callback runs off the `session_start`
 * handler so nothing here is on the blocking path, but it starts racing the
 * model's first tool call immediately. It has ~2.9 s of handshake to get
 * through against a warm CBM daemon and ~9 s when the daemon has to start, and
 * a query will not wait for it -- so every millisecond of head start is a
 * search that gets graph context instead of nothing.
 *
 * The cost is one CBM client at 2.6 MB resident, against a daemon that already
 * holds the graph for this account.
 */
const WARM_DELAY_MS = 0;

export default function ompCodebaseMemoryAugmentation(pi: ExtensionAPI): void {
  const host = processHost();

  // Same stand-down as the main entry. A future upstream `--clients=omp` would
  // write its own native extension, and OMP deduplicates extension modules by
  // absolute path, so both would load and every search would be augmented twice.
  const native = nativeExtensionPath(host);
  if (existsSync(native)) {
    pi.logger.info("omp-codebase-memory: augmentation standing down", { native });
    return;
  }

  /**
   * The context of the call currently being handled.
   *
   * Notifications belong to the session whose tool call triggered them, so the
   * sink reads the live context rather than capturing the first one it saw.
   */
  let current: ExtensionContext | null = null;
  let augmenter: Augmenter | null = null;

  const debug = (message: string): void => {
    pi.logger.info("omp-codebase-memory: augmentation", { message });
  };

  /**
   * The augmenter, built once and shared by the warm-up and the handler.
   *
   * `cwd` comes from whichever context arrives first, and both events carry the
   * same session's directory.
   */
  const ensure = (ctx: ExtensionContext): Augmenter => {
    augmenter ??= createAugmenter({
      // At most once: an executable that has already failed to resolve is not
      // asked again for the life of the session.
      openClient: async () => {
        const resolution = await resolveExecutable(host, await readState(host));
        if (!resolution.ok) {
          debug(`no executable resolved: ${resolution.reason}`);
          return null;
        }
        return openGraphClient(resolution.resolved.executable, { onDebug: debug });
      },
      cwd: ctx.cwd,
      // The augmenter is what guarantees one notice per cause; this only has to
      // render it, and must not turn a failed overlay into a failed tool result.
      notify: (message) => {
        try {
          current?.ui.notify(message, "info");
        } catch (error) {
          debug(`notification failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
      debug,
    });
    return augmenter;
  };

  /**
   * Session start: open the graph session in the background and nowhere near
   * the blocking path.
   *
   * Deferred onto a managed timer, for the reason `src/scheduler.ts` gives, and
   * short enough to land before a first search: a session's first tool call
   * follows its first model turn, which is slower than this. A search that
   * arrives first still costs nothing -- it refuses to wait for the handshake
   * and appends nothing.
   */
  pi.on("session_start", (_event, ctx) => {
    current = ctx;
    const augment = ensure(ctx);
    schedulerFrom(ctx).after(() => {
      void augment.warm();
    }, WARM_DELAY_MS);
  });

  pi.on("tool_result", async (event, ctx) => {
    current = ctx;
    return await ensure(ctx).handle(event);
  });

  // The graph session is the one resource this entry holds. Released here so a
  // long-lived OMP process does not accumulate one CBM client per session it
  // has opened.
  pi.on("session_shutdown", () => {
    augmenter?.close();
    augmenter = null;
    current = null;
  });
}
