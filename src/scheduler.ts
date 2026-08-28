import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/**
 * The deferred-work seam, over OMP's managed timers.
 *
 * Extensions run in-process with no isolation, and a raw `setTimeout` callback
 * that throws escapes handler dispatch entirely: it surfaces as a process-level
 * `uncaughtException`, and OMP's postmortem handler treats that as fatal and
 * tears down the whole session. The handler context's timer methods run their
 * callback with the same isolation as handler dispatch, are `unref`'d, and are
 * cleared on `session_shutdown`.
 *
 * So the platform timer globals are not called anywhere in this package, and
 * this adapter is the reason there is nowhere convenient to call them from.
 */

/**
 * An opaque handle to one scheduled callback.
 *
 * `Timer` is the type OMP's managed methods return, and a global in `bun-types`.
 */
export type TimerHandle = Timer;

export interface Scheduler {
  /** Runs `callback` once, after `ms`. */
  after(callback: () => void, ms: number): TimerHandle;
  /** Cancels a callback that has not run yet. */
  cancel(handle: TimerHandle): void;
}

/** The scheduler backed by one handler context's managed timers. */
export function schedulerFrom(ctx: ExtensionContext): Scheduler {
  return {
    after(callback, ms) {
      return ctx.setTimeout(callback, ms);
    },
    cancel(handle) {
      ctx.clearTimer(handle);
    },
  };
}
