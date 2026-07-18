"use client";
// L1-5000 / prompts 4455,4513,4567,4605,4643,4681,4719: addressed by this module (duplicates of Section I prompts, originally implemented there).

/**
 * Prompt I-982 / J-4151 — Real GDPR export (UI button).
 *
 * Triggers a client-side download of the full GDPR data export
 * (right of access, Article 15). Calls `/api/player/data-export`
 * which returns the structured JSON payload assembled by
 * `getDataExport(playerId)` in `platform/gdpr.ts`.
 *
 * The export includes:
 *   - Player row (callsign, level, credits, settings).
 *   - Inventory (weapons, attachments, operators, wraps, charms).
 *   - Loadouts (per-slot weapon + attachment + skin configuration).
 *   - Battle pass progress (current season + tier + claimed rewards).
 *   - Match earnings (per-match credit + XP history).
 *   - Medical state + inventory (in-match healing items).
 *   - Challenges (claimed + in-progress + their progress counters).
 *   - Operator customizations (cosmetic overrides).
 *   - Events (every PlayerEvent row — analytics history).
 *   - PlayerSessions (session start/end timestamps for crash-free calc).
 *   - Consent records (GDPR consent state per consent type).
 *
 * The button shows a spinner while the export is fetching + a
 * success toast when the download starts. Failures (e.g. server
 * error) show an error toast with the response's error message.
 *
 * Mount in the SettingsPanel under the Privacy tab. The button is
 * self-contained.
 */

import { useState } from "react";
import { Download, Loader2, AlertCircle, Check } from "lucide-react";
import { toast } from "sonner";
import { announceMenuMessage } from "./MenuScreenReader";

type Status = "idle" | "loading" | "done" | "error";

export function GdprExportButton({ className = "" }: { className?: string }) {
  const [status, setStatus] = useState<Status>("idle");

  const handleExport = async () => {
    setStatus("loading");
    announceMenuMessage("Generating data export…");
    try {
      const res = await fetch("/api/player/data-export", { method: "GET" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Export failed (HTTP ${res.status})`);
      }
      const payload = await res.json();
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      a.download = `project-reality-data-export-${ts}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setStatus("done");
      toast.success("Data export downloaded");
      announceMenuMessage("Data export downloaded");
      setTimeout(() => setStatus("idle"), 2000);
    } catch (err) {
      setStatus("error");
      const msg = err instanceof Error ? err.message : "Export failed";
      toast.error(msg);
      announceMenuMessage(`Export failed: ${msg}`);
      setTimeout(() => setStatus("idle"), 3000);
    }
  };

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <div className="flex items-center gap-2">
        <Download className="h-4 w-4 text-amber-400" />
        <h3 className="text-sm font-semibold text-white/90">Data Export (GDPR)</h3>
      </div>
      <p className="text-[11px] leading-relaxed text-white/40">
        Download every piece of data Project Reality holds about you
        (profile, inventory, loadouts, battle pass, sessions, events,
        consent records). Right of access, GDPR Article 15.
      </p>
      <button
        type="button"
        onClick={handleExport}
        disabled={status === "loading"}
        className="flex h-9 items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-4 text-xs font-semibold text-white/80 transition-colors hover:bg-white/[0.08] hover:text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 focus-visible:ring-offset-4 focus-visible:ring-offset-[#08090c]"
      >
        {status === "loading" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : status === "done" ? (
          <Check className="h-3.5 w-3.5" />
        ) : status === "error" ? (
          <AlertCircle className="h-3.5 w-3.5" />
        ) : (
          <Download className="h-3.5 w-3.5" />
        )}
        {status === "loading"
          ? "Generating…"
          : status === "done"
            ? "Downloaded"
            : status === "error"
              ? "Failed"
              : "Download my data"}
      </button>
    </div>
  );
}
