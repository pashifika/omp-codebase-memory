import { existsSync } from "node:fs";

import { createAugmenter } from "./augment.ts";
import { openGraphClient } from "./graph.ts";
import { nativeExtensionPath, processHost } from "./paths.ts";
import { resolveExecutable } from "./resolve.ts";
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
 * Registers `tool_result` and `session_shutdown`, and never `tool_call`: a
 * throwing or blocking `tool_call` handler is a refusal of the tool call, so a
 * graph query that stalled could deny the operator's `grep`.
 */
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

  pi.on("tool_result", async (event, ctx) => {
    current = ctx;
    augmenter ??= createAugmenter({
      // Lazy, and at most once: a session that never searches never starts a
      // CBM process, and an executable that has already failed to resolve is
      // not asked again.
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
    return await augmenter.handle(event);
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
