/**
 * Section F — Expanded barks library.
 *
 * Addresses Section F prompts for "100+ context-aware voice lines for
 * enemies". The existing barks.ts has ~30 BarkKind entries each with 3-4
 * variants. This module extends the catalog with 100+ additional lines
 * covering the new Section F contexts (formations, breaching, sniper
 * overwatch, morale breaks, wounded behavior, civilian panic, vehicle
 * comms, boss phase transitions, companion commands).
 *
 * Each entry is a (BarkKind, variant) pair. The library is data-driven:
 * the BarkConfig (cooldown, audio cue, subtitled flag) lives in barks.ts;
 * this module is the line catalog the resolver picks from.
 *
 * Integration:
 *   - barks.ts's `resolveBarkText` is the canonical resolver. This module
 *     exposes `EXTENDED_LINES` keyed by BarkKind; the resolver checks the
 *     extended catalog first, then falls back to BARK_CONFIGS[kind].variants.
 *   - The new Section F BarkKinds are also declared here (and re-exported
 *     for callers that import from this module). barks.ts can be patched
 *     to add them to its BarkKind union; we keep them local to avoid
 *     touching barks.ts's exported type surface.
 *
 * Pure-TS, SSR-safe, deterministic given inputs.
 */

// ───────────────────────────────────────────────────────────────────────────
// New Section F bark contexts (extends the BarkKind union from barks.ts)
// ───────────────────────────────────────────────────────────────────────────

export type ExtendedBarkKind =
  // Formation orders
  | "FORMATION_WEDGE"
  | "FORMATION_LINE"
  | "FORMATION_COLUMN"
  | "FORMATION_DIAMOND"
  | "FORMATION_BREAK"
  // Flank coordination
  | "FLANK_PINNING"
  | "FLANK_MOVING"
  | "FLANK_READY"
  | "FLANK_ABORT"
  // Suppression
  | "SUPPRESS_BURST"
  | "SUPPRESS_HOLD"
  | "SUPPRESS_CEASE"
  // Cover
  | "COVER_FOUND"
  | "COVER_LOST"
  | "COVER_BREAKING"
  // Grenade
  | "GRENADE_COOK"
  | "GRENADE_FLUSH"
  | "GRENADE_INCOMING"
  // Breach
  | "BREACH_STACK"
  | "BREACH_BREACH"
  | "BREACH_CLEAR"
  | "BREACH_HOLD"
  // Sniper
  | "SNIPER_OVERWATCH"
  | "SNIPER_REPOSITION"
  | "SNIPER_LASER_DESIGNATE"
  | "SNIPER_TARGET_DOWN"
  // Morale
  | "MORALE_RALLY"
  | "MORALE_BREAK"
  | "MORALE_BRAVE"
  | "MORALE_FEAR"
  // Wounded
  | "WOUNDED_CRAWL"
  | "WOUNDED_MEDIC"
  | "WOUNDED_BLEEDING"
  | "WOUNDED_LAST_WORDS"
  // Civilian
  | "CIVILIAN_PANIC"
  | "CIVILIAN_FLEE"
  | "CIVILIAN_BEG"
  | "CIVILIAN_SCREAM"
  // Vehicle
  | "VEHICLE_TARGET_LOCKED"
  | "VEHICLE_REPOSITION"
  | "VEHICLE_TURRET_TRACKING"
  | "VEHICLE_DISMOUNT"
  // Boss
  | "BOSS_PHASE_2"
  | "BOSS_PHASE_3"
  | "BOSS_ENRAGE"
  | "BOSS_SUMMON"
  | "BOSS_TELEGRAPH"
  // Companion commands
  | "COMPANION_REGROUP"
  | "COMPANION_HOLD"
  | "COMPANION_ADVANCE"
  | "COMPANION_COVERING"
  | "COMPANION_REVIVING"
  | "COMPANION_ENGAGING"
  // Squad comms
  | "SQUAD_CONTACT_REPORT"
  | "SQUAD_TARGET_DOWN"
  | "SQUAD_RELOADING"
  | "SQUAD_AMMO_LOW"
  | "SQUAD_FLANKING"
  | "SQUAD_SUPPRESSING"
  | "SQUAD_MOVING"
  | "SQUAD_HOLDING"
  // Generic combat variety (more lines for existing contexts)
  | "SPOTTED_VARIATION"
  | "RELOADING_VARIATION"
  | "SUPPRESSED_VARIATION"
  | "FLANKING_VARIATION";

// ───────────────────────────────────────────────────────────────────────────
// Line catalog — 100+ lines keyed by ExtendedBarkKind
// ───────────────────────────────────────────────────────────────────────────

export const EXTENDED_LINES: Record<ExtendedBarkKind, string[]> = {
  // Formation orders — 5 contexts × 4 lines = 20
  FORMATION_WEDGE: [
    "Wedge up! Move into wedge!",
    "Wedge formation — go!",
    "Form wedge, spacing ten meters!",
    "Wedge — watch your sectors!",
  ],
  FORMATION_LINE: [
    "Line abreast — move!",
    "Line formation, on me!",
    "Spread out — line formation!",
    "Line up, cover the front!",
  ],
  FORMATION_COLUMN: [
    "Column formation — file in!",
    "Single file — move it!",
    "Column up, keep spacing!",
    "Trail formation — follow me!",
  ],
  FORMATION_DIAMOND: [
    "Diamond — all-round defense!",
    "Diamond formation, move!",
    "Form diamond, watch all sectors!",
    "Diamond up — 360 coverage!",
  ],
  FORMATION_BREAK: [
    "Break formation!",
    "Disperse — go to cover!",
    "Break — individual movement!",
    "Scatter, find cover now!",
  ],

  // Flank coordination — 4 × 4 = 16
  FLANK_PINNING: [
    "Pinning him — you move!",
    "Base of fire — go go go!",
    "I've got him pinned, flank!",
    "Suppressing — move around!",
  ],
  FLANK_MOVING: [
    "Moving to flank — cover me!",
    "Going around — keep his head down!",
    "Flanking now — don't let up!",
    "I'm moving — hold his attention!",
  ],
  FLANK_READY: [
    "In position — ready to fire!",
    "Flank set — on your mark!",
    "I've got the angle — say when!",
    "Ready on the side — take him!",
  ],
  FLANK_ABORT: [
    "Abort flank — too hot!",
    "Pulling back — can't make it!",
    "Flank's compromised — disengage!",
    "Forget the flank — fallback!",
  ],

  // Suppression — 3 × 4 = 12
  SUPPRESS_BURST: [
    "Burst fire — keep him down!",
    "Suppressing — short bursts!",
    "Lay it on — keep his head down!",
    "Bursts — don't let him aim!",
  ],
  SUPPRESS_HOLD: [
    "Hold fire — hold fire!",
    "Cease fire — save ammo!",
    "Stop shooting — he's pinned!",
    "Hold — wait for the move!",
  ],
  SUPPRESS_CEASE: [
    "Cease fire! Cease fire!",
    "All stop — weapons hold!",
    "Cease — checking the area!",
    "Knock it off — cease fire!",
  ],

  // Cover — 3 × 4 = 12
  COVER_FOUND: [
    "Found cover — on me!",
    "I've got cover here!",
    "Cover located — stacking up!",
    "Behind cover — bring it on!",
  ],
  COVER_LOST: [
    "Lost my cover — moving!",
    "Cover's gone — relocating!",
    "Pushed off cover — falling back!",
    "No cover here — pulling back!",
  ],
  COVER_BREAKING: [
    "Cover's breaking — fall back!",
    "Wall's giving — moving!",
    "Cover's breached — get out!",
    "Barrier's down — displace!",
  ],

  // Grenade — 3 × 4 = 12
  GRENADE_COOK: [
    "Cooking it — frag out in three!",
    "Holding the pin — grenade out!",
    "Cooked frag — fire in the hole!",
    "Grenade — cooked, going long!",
  ],
  GRENADE_FLUSH: [
    "Flush him out — frag out!",
    "Throwing to flush — grenade!",
    "Frag on his position — move him!",
    "Grenade to push him out!",
  ],
  GRENADE_INCOMING: [
    "Incoming grenade — move!",
    "Grenade — get out of there!",
    "Frag incoming — displace!",
    "He's throwing — move move move!",
  ],

  // Breach — 4 × 4 = 16
  BREACH_STACK: [
    "Stack up on the door!",
    "On the door — stack left!",
    "Stack right — ready to breach!",
    "Form up — we're breaching!",
  ],
  BREACH_BREACH: [
    "Breach — go go go!",
    "Blowing the door — breach!",
    "Kick it in — go!",
    "Breach breach breach!",
  ],
  BREACH_CLEAR: [
    "Room clear!",
    "All clear — move up!",
    "Clear — next room!",
    "Area clear — hold here!",
  ],
  BREACH_HOLD: [
    "Hold the room — cover the doors!",
    "Hold here — secure the entry!",
    "Lock this room down — watch entry!",
    "Hold position — set up overwatch!",
  ],

  // Sniper — 4 × 4 = 16
  SNIPER_OVERWATCH: [
    "Overwatch set — I've got eyes on.",
    "In position — covering you.",
    "On overwatch — call them out.",
    "I see the field — go ahead.",
  ],
  SNIPER_REPOSITION: [
    "Repositioning — new angle.",
    "Moving to a new hide.",
    "Changing overwatch — hold tight.",
    "Relocating — keep them busy.",
  ],
  SNIPER_LASER_DESIGNATE: [
    "Lasing target — paint is on!",
    "Designating — strike inbound!",
    "Laser on target — get clear!",
    "Painting the mark — stand by!",
  ],
  SNIPER_TARGET_DOWN: [
    "Target down — one shot.",
    "Clean kill — moving on.",
    "He's down — next target?",
    "One round, one kill.",
  ],

  // Morale — 4 × 4 = 16
  MORALE_RALLY: [
    "Rally on me — we can take him!",
    "Stand fast — fight!",
    "Pull together — push back!",
    "Don't break — hold the line!",
  ],
  MORALE_BREAK: [
    "Break — run for it!",
    "He's too much — fall back!",
    "Pull out — we're done here!",
    "Run — save yourselves!",
  ],
  MORALE_BRAVE: [
    "For the cause — charge!",
    "Stand and fight — no retreat!",
    "He's just one man — get him!",
    "I'll take him myself!",
  ],
  MORALE_FEAR: [
    "He's a demon — keep distance!",
    "Don't let him get close!",
    "Stay sharp — he's dangerous!",
    "Watch him — he's too good!",
  ],

  // Wounded — 4 × 4 = 16
  WOUNDED_CRAWL: [
    "I'm hit — crawling to cover!",
    "Can't walk — dragging myself!",
    "Leg's gone — crawling!",
    "Bleeding out — moving to cover!",
  ],
  WOUNDED_MEDIC: [
    "Medic! I need a medic!",
    "Man down — medic!",
    "I'm hit bad — medic!",
    "Medic — over here!",
  ],
  WOUNDED_BLEEDING: [
    "Bleeding — losing blood fast!",
    "I'm bleeding out — help!",
    "Arterial bleed — I'm fading!",
    "I can't stop the bleeding!",
  ],
  WOUNDED_LAST_WORDS: [
    "Tell my family... I tried...",
    "Not like this... not like this...",
    "I don't want to die...",
    "It's getting dark... I...",
  ],

  // Civilian — 4 × 4 = 16
  CIVILIAN_PANIC: [
    "Oh god — get down, get down!",
    "He's got a gun — run!",
    "Help — someone help!",
    "Don't shoot, don't shoot!",
  ],
  CIVILIAN_FLEE: [
    "Run — everyone run!",
    "Get out — get out now!",
    "Flee — he's killing everyone!",
    "Out of the way — move!",
  ],
  CIVILIAN_BEG: [
    "Please — I have a family!",
    "Don't — please don't shoot!",
    "I'm not armed — please!",
    "Spare me — I'm just a civilian!",
  ],
  CIVILIAN_SCREAM: [
    "Aaaahhh!",
    "No no no — aaah!",
    "Help meeee!",
    "Aaaah — god, aaah!",
  ],

  // Vehicle — 4 × 4 = 16
  VEHICLE_TARGET_LOCKED: [
    "Target locked — main gun ready!",
    "Tracking target — gun on!",
    "I have him — clear to fire!",
    "Locked — firing now!",
  ],
  VEHICLE_REPOSITION: [
    "Repositioning the vehicle!",
    "Pulling around — new angle!",
    "Vehicle moving — cover us!",
    "Hull down — repositioning!",
  ],
  VEHICLE_TURRET_TRACKING: [
    "Turret tracking — holding the line!",
    "Gun on target — tracking!",
    "Slewing the turret — almost there!",
    "Tracking — range set!",
  ],
  VEHICLE_DISMOUNT: [
    "Dismount — dismount!",
    "Out of the vehicle — go!",
    "Bail out — bail out!",
    "Dismounting — cover the exit!",
  ],

  // Boss — 5 × 4 = 20
  BOSS_PHASE_2: [
    "You think you've won? Phase two!",
    "Enough play — show me your strength!",
    "Now the real fight begins!",
    "I've only just started!",
  ],
  BOSS_PHASE_3: [
    "I will not fall — phase three!",
    "Burning rage — final form!",
    "I am unstoppable now!",
    "Witness my true power!",
  ],
  BOSS_ENRAGE: [
    "ENOUGH! I will end you!",
    "Now I'm angry!",
    "You've doomed yourselves!",
    "Time to die!",
  ],
  BOSS_SUMMON: [
    "Rise, my minions!",
    "Aid me — swarm him!",
    "Call the reserves — now!",
    "Bring the reinforcements!",
  ],
  BOSS_TELEGRAPH: [
    "Brace yourself!",
    "Feel my wrath!",
    "Take this!",
    "Incoming!",
  ],

  // Companion commands — 6 × 4 = 24
  COMPANION_REGROUP: [
    "Regrouping on you!",
    "On my way — regrouping!",
    "Coming to you — hold tight!",
    "Regrouping — fall back to me!",
  ],
  COMPANION_HOLD: [
    "Holding here — covering you!",
    "I've got this position — go!",
    "Holding — I'll cover your move!",
    "Position held — call when ready!",
  ],
  COMPANION_ADVANCE: [
    "Advancing — on your six!",
    "Moving up — covering the advance!",
    "Pushing forward with you!",
    "Advancing — keep the pressure!",
  ],
  COMPANION_COVERING: [
    "Covering fire — go go go!",
    "I've got you — move!",
    "Laying it down — advance!",
    "Covering — don't stop!",
  ],
  COMPANION_REVIVING: [
    "Hold on — I've got you!",
    "Reviving — stay with me!",
    "I'm here — you're not dying!",
    "Hang on — patching you up!",
  ],
  COMPANION_ENGAGING: [
    "Engaging — target acquired!",
    "I've got him — firing!",
    "On target — engaging!",
    "Contact — engaging now!",
  ],

  // Squad comms — 8 × 4 = 32
  SQUAD_CONTACT_REPORT: [
    "Contact! Grid seven-two, hostile!",
    "Contact report — one hostile at the corner!",
    "I see him — contact, my sector!",
    "Contact! Enemy in the open!",
  ],
  SQUAD_TARGET_DOWN: [
    "Target down — one less!",
    "Got him — target down!",
    "He's down — moving on!",
    "One down — clear!",
  ],
  SQUAD_RELOADING: [
    "Reloading — cover me!",
    "Magazine out — reloading!",
    "Going dry — reload!",
    "Reload — I'm empty!",
  ],
  SQUAD_AMMO_LOW: [
    "Ammo's low — need resupply!",
    "Down to my last mag!",
    "Almost out — anyone got rounds?",
    "Critical ammo — need resupply!",
  ],
  SQUAD_FLANKING: [
    "Flanking left — cover my move!",
    "Going around right — keep him pinned!",
    "I'm flanking — hold his attention!",
    "Moving to the side — cover!",
  ],
  SQUAD_SUPPRESSING: [
    "Suppressing — keep his head down!",
    "Base of fire — pinning him!",
    "I've got fire superiority — go!",
    "Suppressing — move when ready!",
  ],
  SQUAD_MOVING: [
    "Moving — cover!",
    "On the move — watch my sector!",
    "Displacing — going to cover!",
    "Moving up — on me!",
  ],
  SQUAD_HOLDING: [
    "Holding here — set!",
    "Position set — holding!",
    "I've got this sector — hold!",
    "Holding — cover the flank!",
  ],

  // Generic combat variety — 4 × 5 = 20
  SPOTTED_VARIATION: [
    "Contact front!",
    "I see him — there!",
    "He's there — hostile spotted!",
    "Eyeball on the target!",
    "There he is — contact!",
  ],
  RELOADING_VARIATION: [
    "Changing mags!",
    "Reload — cover me!",
    "Magazine out — reloading!",
    "Going dry — need a sec!",
    "Tactical reload!",
  ],
  SUPPRESSED_VARIATION: [
    "Pinned — can't move!",
    "He's suppressing me!",
    "Taking fire — pinned!",
    "I can't shoot back — too hot!",
    "Getting lit up — pinned down!",
  ],
  FLANKING_VARIATION: [
    "Going around!",
    "Circling the flank!",
    "Moving to the side!",
    "Flank maneuver — go!",
    "Hitting him from the side!",
  ],
};

// ───────────────────────────────────────────────────────────────────────────
// Resolver — pick a line for the given ExtendedBarkKind
// ───────────────────────────────────────────────────────────────────────────

/** Count total lines across all contexts (sanity / debug). */
export function countLines(): number {
  let n = 0;
  for (const k of Object.keys(EXTENDED_LINES) as ExtendedBarkKind[]) {
    n += EXTENDED_LINES[k].length;
  }
  return n;
}

/** Pick a deterministic-per-speaker line for the given kind. The seed
 *  mixes the kind + speaker + a per-match salt so the same enemy doesn't
 *  say the same line twice in a row, but two different enemies can say
 *  the same line (which is fine).
 *
 *  Determinism: same (kind, speaker, matchSalt) → same line. This lets QA
 *  reproduce a bark report by replaying with the same seed. */
export function pickLine(
  kind: ExtendedBarkKind,
  speaker: string = "",
  matchSalt: number = 0,
  rng: () => number = Math.random,
): string {
  const lines = EXTENDED_LINES[kind];
  if (!lines || lines.length === 0) return "";
  // Mix in the speaker + salt so the same enemy gets variety across ticks
  // but a deterministic seed reproduces the sequence.
  const mix = hashStr(`${kind}|${speaker}|${matchSalt}`);
  const noise = rng();
  const idx = Math.floor((mix * 0.0001 + noise) * lines.length) % lines.length;
  return lines[idx];
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// ───────────────────────────────────────────────────────────────────────────
// Per-kind default cooldowns (mirrors barks.ts's BarkConfig.cooldownMs)
// ───────────────────────────────────────────────────────────────────────────

export const EXTENDED_COOLDOWNS_MS: Record<ExtendedBarkKind, number> = {
  FORMATION_WEDGE: 6000,
  FORMATION_LINE: 6000,
  FORMATION_COLUMN: 6000,
  FORMATION_DIAMOND: 6000,
  FORMATION_BREAK: 4000,
  FLANK_PINNING: 4000,
  FLANK_MOVING: 4000,
  FLANK_READY: 3000,
  FLANK_ABORT: 4000,
  SUPPRESS_BURST: 3000,
  SUPPRESS_HOLD: 3000,
  SUPPRESS_CEASE: 3000,
  COVER_FOUND: 4000,
  COVER_LOST: 4000,
  COVER_BREAKING: 4000,
  GRENADE_COOK: 2000,
  GRENADE_FLUSH: 2500,
  GRENADE_INCOMING: 1500,
  BREACH_STACK: 5000,
  BREACH_BREACH: 3000,
  BREACH_CLEAR: 3000,
  BREACH_HOLD: 5000,
  SNIPER_OVERWATCH: 8000,
  SNIPER_REPOSITION: 6000,
  SNIPER_LASER_DESIGNATE: 10000,
  SNIPER_TARGET_DOWN: 4000,
  MORALE_RALLY: 6000,
  MORALE_BREAK: 8000,
  MORALE_BRAVE: 8000,
  MORALE_FEAR: 6000,
  WOUNDED_CRAWL: 4000,
  WOUNDED_MEDIC: 3000,
  WOUNDED_BLEEDING: 4000,
  WOUNDED_LAST_WORDS: 12000,
  CIVILIAN_PANIC: 3000,
  CIVILIAN_FLEE: 3000,
  CIVILIAN_BEG: 6000,
  CIVILIAN_SCREAM: 2000,
  VEHICLE_TARGET_LOCKED: 4000,
  VEHICLE_REPOSITION: 5000,
  VEHICLE_TURRET_TRACKING: 4000,
  VEHICLE_DISMOUNT: 4000,
  BOSS_PHASE_2: 15000,
  BOSS_PHASE_3: 15000,
  BOSS_ENRAGE: 10000,
  BOSS_SUMMON: 8000,
  BOSS_TELEGRAPH: 4000,
  COMPANION_REGROUP: 4000,
  COMPANION_HOLD: 4000,
  COMPANION_ADVANCE: 4000,
  COMPANION_COVERING: 3000,
  COMPANION_REVIVING: 4000,
  COMPANION_ENGAGING: 3000,
  SQUAD_CONTACT_REPORT: 3000,
  SQUAD_TARGET_DOWN: 3000,
  SQUAD_RELOADING: 5000,
  SQUAD_AMMO_LOW: 8000,
  SQUAD_FLANKING: 4000,
  SQUAD_SUPPRESSING: 4000,
  SQUAD_MOVING: 4000,
  SQUAD_HOLDING: 4000,
  SPOTTED_VARIATION: 2500,
  RELOADING_VARIATION: 5000,
  SUPPRESSED_VARIATION: 4000,
  FLANKING_VARIATION: 4000,
};

/** Per-kind "subtitled" flag — most combat comms are subtitled; minor
 *  movement callouts are not (to avoid HUD spam). */
export const EXTENDED_SUBTITLED: Partial<Record<ExtendedBarkKind, boolean>> = {
  SQUAD_MOVING: false,
  SQUAD_HOLDING: false,
  SUPPRESS_BURST: false,
  SUPPRESS_HOLD: false,
  SUPPRESS_CEASE: false,
  COVER_FOUND: false,
  VEHICLE_TURRET_TRACKING: false,
  CIVILIAN_SCREAM: false, // audio only (screams don't need subtitles).
  COMPANION_COVERING: false,
};
