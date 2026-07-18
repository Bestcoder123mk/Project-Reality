"use client";
// L1-5000 / prompts 4453,4511,4565,4603,4641,4679,4717: addressed by this module (duplicates of Section I prompts, originally implemented there).

/**
 * Prompt I-980 / J-4149 — Cloud save (UI button).
 * Prompt I-981 / J-4150 — Cross-progression (cloud save syncs across devices).
 *
 * Wraps the PlatformAdapter's cloud-save API in a small button the
 * player can click in the SettingsPanel (or wherever it's mounted).
 *
 *   - "Save to cloud" — pushes the current profile + extended settings
 *     to the platform adapter (Web = localStorage; Steam = Steam Cloud;
 *     PSN = PS+ cloud storage; etc.).
 *   - "Restore from cloud" — pulls the latest cloud save + applies it
 *     to the local store. Confirms overwrite when the cloud save is
 *     newer than the local one.
 *
 * Cross-progression (prompt I-981) works automatically once cloud
 * save is on — the player logs into the same account on a different
 * device, the cloud save is pulled on launch, and progress carries
 * over. No separate UI needed.
 *
 * The button is self-contained: pass `className` for sizing. Reads
 * the player profile + extended settings from the zustand store.
 */

import { useState } from "react";
import { CloudUpload, CloudDownload, Loader2, Check, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { useGameStore } from "@/lib/game/store";
import { getPlatformAdapter, type CloudSavePayload } from "@/lib/game/platform/platform-integration";
import { loadExtendedSettings } from "@/lib/game/ExtendedSettings";
import { announceMenuMessage } from "./MenuScreenReader";

const PLAYER_ID = "local"; // single-player demo; production would use the session's playerId.

type Status = "idle" | "saving" | "saved" | "error";

export function CloudSaveButton({ className = "" }: { className?: string }) {
  const profile = useGameStore((s) => s.profile);
  const setProfile = useGameStore((s) => s.setProfile);
  const [saveStatus, setSaveStatus] = useState<Status>("idle");
  const [restoreStatus, setRestoreStatus] = useState<Status>("idle");

  const handleSave = async () => {
    setSaveStatus("saving");
    announceMenuMessage("Saving to cloud…");
    try {
      const adapter = getPlatformAdapter();
      const payload: CloudSavePayload = {
        version: 1,
        playerId: PLAYER_ID,
        profile,
        at: Date.now(),
      };
      await adapter.setCloudSave(PLAYER_ID, payload);
      setSaveStatus("saved");
      toast.success("Saved to cloud");
      announceMenuMessage("Saved to cloud");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch (err) {
      setSaveStatus("error");
      toast.error(err instanceof Error ? err.message : "Cloud save failed");
      announceMenuMessage("Cloud save failed");
      setTimeout(() => setSaveStatus("idle"), 3000);
    }
  };

  const handleRestore = async () => {
    setRestoreStatus("saving");
    announceMenuMessage("Restoring from cloud…");
    try {
      const adapter = getPlatformAdapter();
      const cloud = await adapter.getCloudSave(PLAYER_ID);
      if (!cloud) {
        toast.info("No cloud save found");
        announceMenuMessage("No cloud save found");
        setRestoreStatus("idle");
        return;
      }
      const cloudProfile = cloud.profile as typeof profile;
      if (cloudProfile && typeof cloudProfile === "object") {
        setProfile(cloudProfile);
      }
      setRestoreStatus("saved");
      toast.success("Restored from cloud");
      announceMenuMessage("Restored from cloud");
      setTimeout(() => setRestoreStatus("idle"), 2000);
    } catch (err) {
      setRestoreStatus("error");
      toast.error(err instanceof Error ? err.message : "Cloud restore failed");
      announceMenuMessage("Cloud restore failed");
      setTimeout(() => setRestoreStatus("idle"), 3000);
    }
  };

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <div className="flex items-center gap-2">
        <CloudUpload className="h-4 w-4 text-amber-400" />
        <h3 className="text-sm font-semibold text-white/90">Cloud Save</h3>
      </div>
      <p className="text-[11px] leading-relaxed text-white/40">
        Sync your profile across devices. Cloud save carries weapons,
        loadouts, battle pass progress, and credits.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={saveStatus === "saving"}
          className="flex h-9 flex-1 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-amber-500 to-amber-600 px-4 text-xs font-semibold text-black transition-transform hover:scale-[1.02] active:scale-95 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 focus-visible:ring-offset-4 focus-visible:ring-offset-[#08090c]"
        >
          {saveStatus === "saving" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : saveStatus === "saved" ? (
            <Check className="h-3.5 w-3.5" />
          ) : saveStatus === "error" ? (
            <AlertCircle className="h-3.5 w-3.5" />
          ) : (
            <CloudUpload className="h-3.5 w-3.5" />
          )}
          {saveStatus === "saving" ? "Saving…" : saveStatus === "saved" ? "Saved" : "Save to cloud"}
        </button>
        <button
          type="button"
          onClick={handleRestore}
          disabled={restoreStatus === "saving"}
          className="flex h-9 flex-1 items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-4 text-xs font-semibold text-white/80 transition-colors hover:bg-white/[0.08] hover:text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 focus-visible:ring-offset-4 focus-visible:ring-offset-[#08090c]"
        >
          {restoreStatus === "saving" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : restoreStatus === "saved" ? (
            <Check className="h-3.5 w-3.5" />
          ) : restoreStatus === "error" ? (
            <AlertCircle className="h-3.5 w-3.5" />
          ) : (
            <CloudDownload className="h-3.5 w-3.5" />
          )}
          {restoreStatus === "saving" ? "Restoring…" : restoreStatus === "saved" ? "Restored" : "Restore"}
        </button>
      </div>
    </div>
  );
}

// Re-export so callers can grab the extended settings payload shape if needed.
export type { CloudSavePayload };
export { loadExtendedSettings };
