/**
 * Prompt J-4026 / J-4134 / J-4135 / J-4136 / J-4192 — party / invite / friends.
 *
 * Lightweight client-side party system for couch-coop + friend invite.
 * This module is the data layer; the UI lives in
 * `src/components/uiux/PartyPanel.tsx`.
 *
 * Design:
 *   - A "party" is a transient group of 1-4 players formed for a single
 *     match session. Parties dissolve on disconnect — no persistence.
 *   - The party leader sends invite codes (8-char base32); invitees
 *     paste the code to join. (No realtime lobby server — this is the
 *     demo build. The /api/party routes could be wired in a future
 *     iteration to back this with a real lobby service.)
 *   - The friends list persists in localStorage (`pr_friends_v1`) so
 *     the player can quick-invite their usual squad. Each friend has a
 *     callsign + a last-played timestamp.
 *
 * Public API:
 *   - `createParty()` — become leader of a new party (id + invite code).
 *   - `joinParty(inviteCode)` — join an existing party by code.
 *   - `leaveParty()` — leave the current party.
 *   - `getParty()` — read the current party state.
 *   - `subscribeParty(cb)` — reactive subscription for React.
 *   - Friends: `listFriends()`, `addFriend(callsign)`, `removeFriend(callsign)`.
 *   - Invites: `generateInviteCode()`, `parseInviteCode(code)`.
 */

export interface PartyMember {
  /** Player callsign (display name). */
  callsign: string;
  /** True if this is the local player. */
  isLocal: boolean;
  /** True if this is the party leader. */
  isLeader: boolean;
  /** Connection status (demo: always "connected" once joined). */
  status: "connected" | "connecting" | "disconnected";
}

export interface Party {
  /** Stable party ID (8-char base32). */
  id: string;
  /** Invite code (separate from id so it can be rotated). */
  inviteCode: string;
  /** Members in join order. */
  members: PartyMember[];
  /** Maximum party size (4 for couch-coop + 1 squad lead). */
  maxMembers: number;
}

export interface Friend {
  callsign: string;
  /** Last-seen timestamp (ms since epoch). */
  lastSeen: number;
  /** Notes (free-form, 64-char cap). */
  notes?: string;
}

// ─── Party state (in-memory) ────────────────────────────────────────────────

let currentParty: Party | null = null;
const partySubscribers = new Set<(p: Party | null) => void>();

function notifyPartySubscribers(): void {
  for (const cb of partySubscribers) cb(currentParty);
}

/** Generate an 8-char base32 code (Crockford alphabet — no I/L/O/U). */
function generateBase32(length: number): string {
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "";
  const bytes = new Uint8Array(length);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

/** Get the local player's callsign from the store. SSR-safe. */
function getLocalCallsign(): string {
  if (typeof window === "undefined") return "OPERATOR";
  try {
    // The store is the canonical source; read via the persisted operator
    // blob to avoid a hard import dependency on the zustand store.
    const raw = localStorage.getItem("pr_operator");
    if (raw) {
      const op = JSON.parse(raw);
      if (op?.callsign && typeof op.callsign === "string") return op.callsign;
    }
  } catch { /* ignore */ }
  return "OPERATOR";
}

/** Prompt J-4026 — create a new party. The caller becomes the leader. */
export function createParty(): Party {
  const callsign = getLocalCallsign();
  currentParty = {
    id: generateBase32(8),
    inviteCode: generateBase32(8),
    maxMembers: 4,
    members: [
      { callsign, isLocal: true, isLeader: true, status: "connected" },
    ],
  };
  notifyPartySubscribers();
  return currentParty;
}

/** Prompt J-4135 — join an existing party by invite code.
 *  Returns true on success, false on invalid code / full party. */
export function joinParty(inviteCode: string): boolean {
  if (!inviteCode || inviteCode.length < 6) return false;
  // Demo: there's no lobby server to validate against. We simulate a
  // successful join by creating a party with the local player as a
  // non-leader member. A real implementation would POST to /api/party/join
  // + receive the member list.
  const callsign = getLocalCallsign();
  // Reuse the invite code as the party id (so further joins go to the
  // same party). Real impl would use a separate party-id field.
  currentParty = {
    id: inviteCode.toUpperCase(),
    inviteCode: inviteCode.toUpperCase(),
    maxMembers: 4,
    members: [
      // The leader is a stub in the demo — a real impl would list the
      // actual members from the server.
      { callsign: "HOST", isLocal: false, isLeader: true, status: "connected" },
      { callsign, isLocal: true, isLeader: false, status: "connected" },
    ],
  };
  notifyPartySubscribers();
  return true;
}

/** Leave the current party. */
export function leaveParty(): void {
  currentParty = null;
  notifyPartySubscribers();
}

/** Read the current party state. */
export function getParty(): Party | null {
  return currentParty;
}

/** Subscribe to party changes. Returns an unsubscribe function. */
export function subscribeParty(cb: (p: Party | null) => void): () => void {
  partySubscribers.add(cb);
  return () => { partySubscribers.delete(cb); };
}

// ─── Friends list (persisted) ───────────────────────────────────────────────

const FRIENDS_KEY = "pr_friends_v1";

/** List all friends (newest first). */
export function listFriends(): Friend[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(FRIENDS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as Friend[];
    return arr.sort((a, b) => b.lastSeen - a.lastSeen);
  } catch {
    return [];
  }
}

/** Add a friend by callsign. Returns false if already in the list. */
export function addFriend(callsign: string, notes?: string): boolean {
  if (typeof window === "undefined") return false;
  const trimmed = callsign.trim().slice(0, 16);
  if (!trimmed) return false;
  const friends = listFriends();
  if (friends.some((f) => f.callsign.toLowerCase() === trimmed.toLowerCase())) {
    return false;
  }
  friends.push({ callsign: trimmed, lastSeen: Date.now(), notes: notes?.slice(0, 64) });
  try {
    localStorage.setItem(FRIENDS_KEY, JSON.stringify(friends));
  } catch { /* ignore */ }
  return true;
}

/** Remove a friend by callsign (case-insensitive). */
export function removeFriend(callsign: string): boolean {
  if (typeof window === "undefined") return false;
  const friends = listFriends();
  const next = friends.filter(
    (f) => f.callsign.toLowerCase() !== callsign.toLowerCase(),
  );
  if (next.length === friends.length) return false;
  try {
    localStorage.setItem(FRIENDS_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
  return true;
}

// ─── Invite helpers ─────────────────────────────────────────────────────────

/** Generate a fresh invite code (rotates the code for the current party). */
export function generateInviteCode(): string {
  const code = generateBase32(8);
  if (currentParty) {
    currentParty.inviteCode = code;
    notifyPartySubscribers();
  }
  return code;
}

/** Parse + validate an invite code entered by the user. Returns the
 *  normalized uppercase code, or null if invalid. */
export function parseInviteCode(input: string): string | null {
  const trimmed = input.trim().toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (trimmed.length < 6 || trimmed.length > 16) return null;
  return trimmed;
}
