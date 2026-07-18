"use client";

import { Component, type ReactNode } from "react";
import { captureException, addBreadcrumb } from "@/lib/errorTracking";

interface Props {
  children: ReactNode;
  /** Where this boundary is mounted — surfaces in the crash report. */
  label?: string;
}
interface State {
  hasError: boolean;
  message?: string;
}

/**
 * GameErrorBoundary — wraps GameCanvas (and any other crash-prone subtree)
 * so a WebGL/runtime crash reports the stack instead of white-screening.
 *
 * Prompt 3 of the AAA roadmap. Renders a recoverable fallback with a
 * "Return to menu" + "Reload" action rather than a blank page.
 *
 * Prompt J-4147 — crash reporting client. The boundary forwards every
 * caught error to `captureException()` (the errorTracking module, which
 * routes to Sentry when configured or POSTs to /api/telemetry/errors as
 * a fallback) + leaves a breadcrumb so the next crash has context. This
 * is the client-side crash reporter — it runs in the browser.
 */
export class GameErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(err: Error): State {
    return { hasError: true, message: err.message };
  }

  componentDidCatch(err: Error, info: { componentStack?: string }) {
    addBreadcrumb("react", "Error boundary caught", "error", {
      label: this.props.label,
      componentStack: info.componentStack,
    });
    captureException(err, {
      severity: "fatal",
      tags: {
        source: "GameErrorBoundary",
        label: this.props.label ?? "unknown",
      },
    });
  }

  handleReset = () => {
    addBreadcrumb("ui", "User reset after crash", "info");
    this.setState({ hasError: false, message: undefined });
  };

  handleReload = () => {
    if (typeof window !== "undefined") window.location.reload();
  };

  // Prompt J-4022 / J-4145 / J-4188 / J-4200 — error recovery / reconnect.
  // The previous boundary only offered "Return" + "Reload". When the
  // crash was network-related (a fetch to /api/* threw, or the
  // WebSocket dropped), a full reload is overkill — the client state
  // is fine, only the server connection is down. "Reconnect" attempts
  // a lightweight ping to /api/health; if it succeeds, the boundary
  // resets + the wrapped subtree re-mounts (the engine's reconnect
  // logic re-fetches the profile / loadout). If the ping fails, the
  // boundary stays broken + the user falls back to Reload.
  handleReconnect = () => {
    if (typeof window === "undefined") return;
    addBreadcrumb("ui", "User requested reconnect after crash", "info");
    // Fire-and-forget ping. On success, reset the boundary so React
    // re-mounts the wrapped children. On failure, leave the boundary
    // broken (the user can still Reload).
    void fetch("/api/health", { method: "GET", cache: "no-store" })
      .then((r) => {
        if (r.ok) {
          this.setState({ hasError: false, message: undefined });
        }
      })
      .catch(() => {
        // Network still down — leave the boundary broken. The user
        // can retry Reconnect or fall back to Reload.
      });
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div
        role="alert"
        className="absolute inset-0 z-[9999] flex flex-col items-center justify-center gap-4 bg-black/90 p-6 text-center text-white"
      >
        <div className="font-display text-2xl font-bold uppercase tracking-widest text-red-500">
          Crash reported
        </div>
        <p className="max-w-md text-sm text-white/70">
          The {this.props.label ?? "game"} subsystem hit an unrecoverable error.
          A report with the stack trace has been filed. You can return to the
          menu or reload the page.
        </p>
        {this.state.message && (
          <pre className="max-w-lg overflow-auto rounded bg-white/5 p-3 text-left font-mono text-xs text-red-300">
            {this.state.message}
          </pre>
        )}
        <div className="flex gap-3">
          <button
            onClick={this.handleReset}
            className="rounded-md border border-white/20 px-4 py-2 text-sm font-semibold uppercase tracking-wider hover:bg-white/10"
          >
            Return
          </button>
          {/* J-4022 — Reconnect button. Lightweight network-recovery
              path that avoids a full page reload when the crash was
              transient (e.g. a fetch timeout). */}
          <button
            onClick={this.handleReconnect}
            className="rounded-md border border-sky-400/40 bg-sky-500/10 px-4 py-2 text-sm font-semibold uppercase tracking-wider text-sky-300 hover:bg-sky-500/20"
          >
            Reconnect
          </button>
          <button
            onClick={this.handleReload}
            className="rounded-md bg-white px-4 py-2 text-sm font-semibold uppercase tracking-wider text-black hover:bg-white/90"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
