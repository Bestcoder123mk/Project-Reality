"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Users, Copy, LogOut, UserPlus, X, Check, ChevronRight } from "lucide-react";
import {
  createParty,
  joinParty,
  leaveParty,
  getParty,
  subscribeParty,
  generateInviteCode,
  parseInviteCode,
  listFriends,
  addFriend,
  removeFriend,
  type Party,
  type Friend,
} from "@/lib/game/uiux/party";

/**
 * Prompt J-4026 / J-4192 — PartyPanel UI.
 *
 * Mounted under the Social tab (or as a floating overlay from the main
 * menu's social button). Surfaces:
 *   - "Create party" / "Join party" entry points.
 *   - The current party's invite code + a copy button.
 *   - The party member list (callsigns, leader badge, status).
 *   - The friends list (add by callsign, quick-invite, remove).
 *
 * The data layer (`party.ts`) handles persistence + the in-memory party
 * state. This component is presentational — it calls the data layer +
 * re-renders on the subscribe callback.
 */

const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 focus-visible:ring-offset-4 focus-visible:ring-offset-[#08090c]";

export function PartyPanel({ onClose }: { onClose?: () => void }) {
  const [party, setParty] = useState<Party | null>(getParty());
  const [joinInput, setJoinInput] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Friends list (read on mount + when add/remove fires).
  const [friends, setFriends] = useState<Friend[]>([]);
  const [newFriendCallsign, setNewFriendCallsign] = useState("");
  const refreshFriends = () => setFriends(listFriends());

  useEffect(() => {
    refreshFriends();
    const unsub = subscribeParty((p) => setParty(p));
    return unsub;
  }, []);

  const handleCreate = () => {
    createParty();
  };

  const handleJoin = () => {
    const code = parseInviteCode(joinInput);
    if (!code) {
      setJoinError("Invalid code — must be 6-16 chars (A-Z, 0-9).");
      return;
    }
    const ok = joinParty(code);
    if (!ok) {
      setJoinError("Failed to join party.");
      return;
    }
    setJoinError(null);
    setJoinInput("");
  };

  const handleLeave = () => {
    leaveParty();
  };

  const handleCopyCode = async () => {
    if (!party) return;
    try {
      await navigator.clipboard.writeText(party.inviteCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — non-fatal */ }
  };

  const handleRotateCode = () => {
    generateInviteCode();
  };

  const handleAddFriend = () => {
    if (!newFriendCallsign.trim()) return;
    const ok = addFriend(newFriendCallsign);
    if (ok) {
      setNewFriendCallsign("");
      refreshFriends();
    }
  };

  const handleRemoveFriend = (callsign: string) => {
    removeFriend(callsign);
    refreshFriends();
  };

  return (
    <div className="mx-auto w-full max-w-md">
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-amber-400" />
            <h3 className="text-sm font-semibold text-white/90">Party</h3>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className={`flex h-7 w-7 items-center justify-center rounded-full bg-white/[0.04] text-white/60 transition-colors hover:bg-white/[0.08] hover:text-white ${FOCUS_RING}`}
              aria-label="Close party panel"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {!party ? (
          /* No active party — entry points. */
          <div className="space-y-3">
            <button
              type="button"
              onClick={handleCreate}
              className={`flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 px-4 py-2.5 text-sm font-semibold text-black shadow-[0_0_18px_rgba(255,140,26,0.25)] transition-transform hover:scale-[1.02] active:scale-95 ${FOCUS_RING}`}
            >
              <UserPlus className="h-4 w-4" /> Create Party
            </button>
            <div className="flex gap-2">
              <input
                type="text"
                value={joinInput}
                onChange={(e) => setJoinInput(e.target.value)}
                placeholder="Invite code…"
                aria-label="Party invite code"
                maxLength={16}
                className={`h-10 flex-1 rounded-xl border border-white/10 bg-white/[0.04] px-3 text-sm text-white/90 placeholder-white/30 outline-none focus:border-amber-500/40 ${FOCUS_RING}`}
              />
              <button
                type="button"
                onClick={handleJoin}
                className={`flex h-10 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] px-4 text-sm font-medium text-white/80 transition-colors hover:bg-white/[0.08] hover:text-white ${FOCUS_RING}`}
              >
                Join
              </button>
            </div>
            {joinError && (
              <div className="text-[11px] text-rose-300">{joinError}</div>
            )}
          </div>
        ) : (
          /* Active party — show members + invite code. */
          <div className="space-y-4">
            {/* Invite code */}
            <div className="rounded-xl border border-amber-500/15 bg-amber-500/[0.04] p-3">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-white/40">
                  Invite Code
                </span>
                <button
                  type="button"
                  onClick={handleRotateCode}
                  className="text-[10px] font-medium text-white/40 transition-colors hover:text-white/70"
                >
                  Rotate
                </button>
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 font-mono text-lg font-bold tracking-[0.3em] text-amber-300">
                  {party.inviteCode}
                </code>
                <button
                  type="button"
                  onClick={handleCopyCode}
                  className={`flex h-8 w-8 items-center justify-center rounded-md bg-white/[0.06] text-white/70 transition-colors hover:bg-white/[0.12] hover:text-white ${FOCUS_RING}`}
                  aria-label="Copy invite code"
                >
                  {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>

            {/* Members */}
            <div>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-white/40">
                Members ({party.members.length}/{party.maxMembers})
              </div>
              <div className="space-y-1">
                {party.members.map((m) => (
                  <div
                    key={`${m.callsign}-${m.isLocal}`}
                    className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5"
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${m.status === "connected" ? "bg-emerald-400" : "bg-amber-400"}`} />
                    <span className="flex-1 text-xs font-medium text-white/85">{m.callsign}</span>
                    {m.isLeader && (
                      <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-300">
                        Leader
                      </span>
                    )}
                    {m.isLocal && (
                      <span className="text-[9px] uppercase tracking-wider text-white/40">you</span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Leave */}
            <button
              type="button"
              onClick={handleLeave}
              className={`flex w-full items-center justify-center gap-1.5 rounded-xl border border-rose-500/20 bg-rose-500/[0.04] px-4 py-2 text-xs font-medium text-rose-300 transition-colors hover:bg-rose-500/[0.08] ${FOCUS_RING}`}
            >
              <LogOut className="h-3.5 w-3.5" /> Leave Party
            </button>
          </div>
        )}
      </div>

      {/* Friends list — always visible (independent of party state). */}
      <div className="mt-4 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-white/60" />
            <h3 className="text-sm font-semibold text-white/90">Friends</h3>
            <span className="text-[10px] text-white/40">({friends.length})</span>
          </div>
        </div>
        <div className="mb-3 flex gap-2">
          <input
            type="text"
            value={newFriendCallsign}
            onChange={(e) => setNewFriendCallsign(e.target.value)}
            placeholder="Add by callsign…"
            aria-label="Friend callsign"
            maxLength={16}
            onKeyDown={(e) => { if (e.key === "Enter") handleAddFriend(); }}
            className={`h-9 flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-xs text-white/90 placeholder-white/30 outline-none focus:border-amber-500/40 ${FOCUS_RING}`}
          />
          <button
            type="button"
            onClick={handleAddFriend}
            disabled={!newFriendCallsign.trim()}
            className={`flex h-9 items-center justify-center rounded-lg bg-white/[0.06] px-3 text-xs font-medium text-white/80 transition-colors hover:bg-white/[0.12] hover:text-white disabled:opacity-40 ${FOCUS_RING}`}
          >
            <UserPlus className="h-3.5 w-3.5" />
          </button>
        </div>
        {friends.length === 0 ? (
          <div className="py-4 text-center text-[11px] text-white/40">
            No friends added yet. Add by callsign to quick-invite to parties.
          </div>
        ) : (
          <div className="max-h-48 space-y-1 overflow-y-auto">
            {friends.map((f) => (
              <div
                key={f.callsign}
                className="group flex items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5"
              >
                <span className="flex-1 truncate text-xs font-medium text-white/85">{f.callsign}</span>
                <button
                  type="button"
                  onClick={() => handleRemoveFriend(f.callsign)}
                  className="opacity-0 transition-opacity group-hover:opacity-100"
                  aria-label={`Remove friend ${f.callsign}`}
                >
                  <X className="h-3 w-3 text-white/40 hover:text-rose-400" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Re-export for the SocialPanel integration. */
export default PartyPanel;
