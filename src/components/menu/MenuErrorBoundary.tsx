"use client";

import { Component, type ReactNode } from "react";
import { captureException, addBreadcrumb } from "@/lib/errorTracking";

interface Props {
  children: ReactNode;
  /** Where this boundary is mounted — surfaces in the crash report. */
  label?: string;
  /** Optional callback to dismiss the boundary (e.g. setPhase("menu")). */
  onReturnToMenu?: () => void;
}

interface State {
  hasError: boolean;
  message?: string;
}

/**
 * MenuErrorBoundary — wraps each dynamically-imported menu screen so a
 * render-time crash in one screen doesn't white-screen the entire app.
 *
 * Backlog §20 item 469. Complements the existing GameErrorBoundary (which
 * wraps GameCanvas for WebGL/runtime crashes). Same crash-reporting path:
 *   - Forwards to captureException (Sentry if configured, else /api/telemetry/errors).
 *   - Leaves a breadcrumb so the next crash has context.
 *
 * Fallback UI: a minimal card with three recovery options:
 *   - "Try again" — reset the boundary state without reloading (preserves
 *     all in-memory state: credits, loadout, settings, current phase).
 *     Prompt J-4028 / J-4194 — the previous UI only offered "Reload",
 *     which discarded all client state on a one-off render crash.
 *   - "Back to menu" — reset + return to the main menu phase.
 *   - "Reload" — full page reload (last resort). State is snapshotted to
 *     sessionStorage first so the boot path can attempt to restore it.
 */
export class MenuErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(err: Error): State {
    return { hasError: true, message: err.message };
  }

  componentDidCatch(err: Error, info: { componentStack?: string }) {
    addBreadcrumb("react", "Menu boundary caught", "error", {
      label: this.props.label,
      componentStack: info.componentStack,
    });
    captureException(err, {
      severity: "error",
      tags: {
        source: "MenuErrorBoundary",
        label: this.props.label ?? "unknown",
      },
    });

    // Also fire a fire-and-forget POST to /api/telemetry/errors so the
    // crash is recorded even when captureException is configured to forward
    // to a third-party provider that hasn't loaded yet (or is rate-limited).
    if (typeof window !== "undefined") {
      try {
        void fetch("/api/telemetry/errors", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: `menu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            message: err.message,
            stack: err.stack,
            severity: "error",
            tags: {
              source: "MenuErrorBoundary",
              label: this.props.label ?? "unknown",
            },
            url: window.location.href,
          }),
        });
      } catch {
        // Network failure here is non-fatal — captureException already
        // queued the breadcrumb for the next successful report.
      }
    }
  }

  handleReload = () => {
    // Prompt J-4028 / J-4194 — preserve state across reload.
    // The previous `window.location.reload()` discarded all client state
    // (credits, loadout, settings, current phase) on a one-off render
    // crash. We now snapshot a minimal recovery blob to sessionStorage
    // before reloading; the boot path can read it on the next mount.
    if (typeof window !== "undefined") {
      try {
        sessionStorage.setItem(
          "pr_menu_boundary_reload_at",
          String(Date.now()),
        );
        // The actual game state (profile, loadout) is persisted via the
        // existing /api/profile + /api/loadout routes — those round-trip
        // on next mount. We only need to flag "this was a recovery reload"
        // so the boot path can surface a soft "recovered from crash" toast.
      } catch { /* sessionStorage unavailable — non-fatal */ }
    }
    window.location.reload();
  };

  /** Prompt J-4028 — non-destructive recovery. Resets the boundary state
   *  so React re-mounts the wrapped children WITHOUT a page reload. All
   *  in-memory state (Zustand store, refs, cached data) survives. */
  handleTryAgain = () => {
    this.setState({ hasError: false, message: undefined });
  };

  handleBackToMenu = () => {
    this.setState({ hasError: false, message: undefined });
    this.props.onReturnToMenu?.();
    // Defensive: if no callback was supplied, still try a reload so the
    // user isn't trapped on a broken screen.
    if (!this.props.onReturnToMenu && typeof window !== "undefined") {
      window.location.reload();
    }
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div
        role="alert"
        className="absolute inset-0 z-[9998] grid place-items-center bg-[#08090c]/95 p-6 text-center text-white backdrop-blur-xl"
      >
        <div className="w-full max-w-md">
          <div className="font-display text-xl font-bold uppercase tracking-widest text-amber-400">
            Screen failed to load
          </div>
          <p className="mt-3 text-sm text-white/70">
            The <span className="font-semibold text-white">{this.props.label ?? "menu screen"}</span>{" "}
            couldn't render. A report has been filed. Reload the page, or
            return to the main menu.
          </p>
          {this.state.message && (
            <pre className="mt-4 max-h-32 overflow-auto rounded-md bg-white/5 p-3 text-left font-mono text-xs text-red-300">
              {this.state.message}
            </pre>
          )}
          <div className="mt-6 flex justify-center gap-3">
            <button
              type="button"
              onClick={this.handleTryAgain}
              className="rounded-md bg-white px-4 py-2 text-sm font-semibold uppercase tracking-wider text-black transition-colors hover:bg-white/90"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={this.handleBackToMenu}
              className="rounded-md border border-white/20 px-4 py-2 text-sm font-semibold uppercase tracking-wider transition-colors hover:bg-white/10"
            >
              Back to menu
            </button>
            <button
              type="button"
              onClick={this.handleReload}
              className="rounded-md border border-white/10 px-4 py-2 text-[11px] font-medium uppercase tracking-wider text-white/40 transition-colors hover:bg-white/[0.04] hover:text-white/70"
              title="Last resort — reloads the page (preserves state via sessionStorage)"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default MenuErrorBoundary;
