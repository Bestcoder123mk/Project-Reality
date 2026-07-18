/**
 * Section K — HUD Customizer (move / scale / hide / tint HUD elements).
 * Player-authored layouts persisted as named profiles.
 * Public API: `HudCustomizer`, `HudElementId`, `HudElementConfig`, `HudProfile`.
 */

export type HudElementId =
  | "minimap" | "compass" | "killFeed" | "weaponStrip" | "ammoCounter"
  | "crosshair" | "damageIndicator" | "killstreakTracker" | "scoreboard" | "pingWheel";

export interface HudElementConfig {
  visible: boolean;
  x: number | null;
  y: number | null;
  scale: number;
  opacity: number;
  tint: string | null;
}

export interface HudProfile {
  name: string;
  elements: Record<HudElementId, HudElementConfig>;
}

const ELEMENT_IDS: HudElementId[] = [
  "minimap", "compass", "killFeed", "weaponStrip", "ammoCounter",
  "crosshair", "damageIndicator", "killstreakTracker", "scoreboard", "pingWheel",
];

const def = (): HudElementConfig => ({ visible: true, x: null, y: null, scale: 1, opacity: 1, tint: null });

const BUILTIN_PROFILES: Record<string, HudProfile> = {
  default: { name: "default", elements: makeElements(() => def()) },
  compact: { name: "compact", elements: makeElements(() => ({ ...def(), scale: 0.8, opacity: 0.85 })) },
  esports: {
    name: "esports",
    elements: makeElements((id) => ({
      ...def(), scale: id === "minimap" ? 0.7 : 0.9, opacity: id === "scoreboard" ? 0 : 0.7,
      visible: id !== "killstreakTracker" && id !== "damageIndicator",
    })),
  },
};

function makeElements(fn: (id: HudElementId) => HudElementConfig): Record<HudElementId, HudElementConfig> {
  const out = {} as Record<HudElementId, HudElementConfig>;
  ELEMENT_IDS.forEach((id) => (out[id] = fn(id)));
  return out;
}

const STORAGE_KEY = "pr_hud_profiles_v1";
const ACTIVE_KEY = "pr_hud_active_v1";
const STATE_KEY = "pr_hud_active_state_v1";

export class HudCustomizer {
  private active: HudProfile = structuredClone(BUILTIN_PROFILES.default);
  private profiles: Record<string, HudProfile> = structuredClone(BUILTIN_PROFILES);
  private listeners = new Set<(p: HudProfile) => void>();

  constructor() { this.load(); }

  get(id: HudElementId): HudElementConfig { return { ...this.active.elements[id] }; }

  set(id: HudElementId, patch: Partial<HudElementConfig>): void {
    this.active.elements[id] = { ...this.active.elements[id], ...patch };
    this.persist(); this.emit();
  }

  reset(id?: HudElementId): void {
    if (id) this.active.elements[id] = def();
    else this.active = structuredClone(BUILTIN_PROFILES.default);
    this.persist(); this.emit();
  }

  saveProfile(name: string): void {
    this.profiles[name] = { name, elements: structuredClone(this.active.elements) };
    this.persist();
  }

  loadProfile(name: string): boolean {
    const p = this.profiles[name];
    if (!p) return false;
    this.active = structuredClone(p);
    try { localStorage.setItem(ACTIVE_KEY, name); } catch { /* ignore */ }
    this.emit();
    return true;
  }

  deleteProfile(name: string): void {
    if (name in BUILTIN_PROFILES) return;
    delete this.profiles[name];
    this.persist();
  }

  listProfiles(): string[] { return Object.keys(this.profiles); }

  subscribe(cb: (p: HudProfile) => void): () => void {
    this.listeners.add(cb);
    cb(this.snapshot());
    return () => this.listeners.delete(cb);
  }

  snapshot(): HudProfile { return structuredClone(this.active); }

  private emit(): void {
    const snap = this.snapshot();
    this.listeners.forEach((cb) => cb(snap));
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.profiles));
      localStorage.setItem(STATE_KEY, JSON.stringify(this.active));
    } catch { /* quota */ }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) this.profiles = { ...BUILTIN_PROFILES, ...JSON.parse(raw) };
      const activeRaw = localStorage.getItem(STATE_KEY);
      if (activeRaw) this.active = JSON.parse(activeRaw);
      else {
        const name = localStorage.getItem(ACTIVE_KEY);
        if (name && this.profiles[name]) this.active = structuredClone(this.profiles[name]);
      }
    } catch { /* keep defaults */ }
  }
}
