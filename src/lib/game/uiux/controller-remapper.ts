/**
 * Section K — Controller Remapper (prompts K_UI_UX_HUD-00026/00037).
 * Button-remapping store: capture/validate/persist bindings, swappable
 * profiles, JSON export. Complements `controller-layouts.ts`.
 * Public API: `ControllerRemapper`, `Binding`, `BindingProfile`.
 */

import { CONTROLLER_LAYOUTS, type ControllerAction, type ControllerPlatform } from "./controller-layouts";

export interface Binding {
  action: ControllerAction;
  buttonIndex: number;
  modifierButton?: number;
  deadzone?: number;
}

export interface BindingProfile {
  name: string;
  platform: ControllerPlatform;
  bindings: Record<ControllerAction, Binding>;
}

const STORAGE_KEY = "pr_controller_profiles_v1";
const ACTIVE_KEY = "pr_controller_active_profile_v1";
const STATE_KEY = "pr_controller_active_state_v1";

function defaultProfile(platform: ControllerPlatform = "xbox"): BindingProfile {
  const layout = CONTROLLER_LAYOUTS[platform];
  const bindings = {} as Record<ControllerAction, Binding>;
  (Object.keys(layout) as ControllerAction[]).forEach((action) => {
    bindings[action] = { action, buttonIndex: layout[action] };
  });
  return { name: "default", platform, bindings };
}

export class ControllerRemapper {
  private profiles: Record<string, BindingProfile>;
  private active: BindingProfile;
  private listeners = new Set<(p: BindingProfile) => void>();
  private captureResolve: ((b: number | null) => void) | null = null;
  private rafId: number | null = null;
  private previousButtons: boolean[] = [];

  constructor(platform: ControllerPlatform = "xbox") {
    this.active = defaultProfile(platform);
    this.profiles = { default: this.active };
    this.load();
  }

  /** Wait for the next button press; returns the button index or null on timeout. */
  beginCapture(timeoutMs = 8000): Promise<number | null> {
    return new Promise((resolve) => {
      this.cancelCapture();
      this.captureResolve = resolve;
      this.previousButtons = [];
      const started = performance.now();
      const poll = () => {
        if (!this.captureResolve) return;
        const pads = typeof navigator !== "undefined" ? navigator.getGamepads?.() ?? [] : [];
        for (const pad of pads) {
          if (!pad) continue;
          for (let i = 0; i < pad.buttons.length; i++) {
            if (pad.buttons[i].pressed && !this.previousButtons[i]) {
              const r = this.captureResolve; this.captureResolve = null; this.previousButtons = [];
              r?.(i); return;
            }
          }
          this.previousButtons = pad.buttons.map((b) => b.pressed);
          break;
        }
        if (performance.now() - started > timeoutMs) {
          const r = this.captureResolve; this.captureResolve = null; r?.(null); return;
        }
        this.rafId = requestAnimationFrame(poll);
      };
      this.rafId = requestAnimationFrame(poll);
    });
  }

  cancelCapture(): void {
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
    if (this.captureResolve) { const r = this.captureResolve; this.captureResolve = null; r(null); }
  }

  /** Assigns a button to an action; swaps any conflicting binding. */
  assign(action: ControllerAction, buttonIndex: number, modifierButton?: number): ControllerAction | null {
    let displaced: ControllerAction | null = null;
    (Object.keys(this.active.bindings) as ControllerAction[]).forEach((a) => {
      const b = this.active.bindings[a];
      if (b.buttonIndex === buttonIndex && b.modifierButton === modifierButton) displaced = a;
    });
    if (displaced && displaced !== action) {
      const old = this.active.bindings[action];
      this.active.bindings[displaced] = { action: displaced, buttonIndex: old.buttonIndex, modifierButton: old.modifierButton };
    }
    this.active.bindings[action] = { action, buttonIndex, modifierButton };
    this.persist(); this.emit(); return displaced;
  }

  unbind(action: ControllerAction): void {
    this.active.bindings[action] = { ...defaultProfile(this.active.platform).bindings[action] };
    this.persist(); this.emit();
  }
  reset(platform?: ControllerPlatform): void {
    this.active = defaultProfile(platform ?? this.active.platform); this.persist(); this.emit();
  }
  saveProfile(name: string): void { this.profiles[name] = structuredClone({ ...this.active, name }); this.persist(); }
  loadProfile(name: string): boolean {
    const p = this.profiles[name]; if (!p) return false;
    this.active = structuredClone(p);
    try { localStorage.setItem(ACTIVE_KEY, name); } catch { /* ignore */ }
    this.emit(); return true;
  }
  deleteProfile(name: string): void { if (name !== "default") { delete this.profiles[name]; this.persist(); } }
  listProfiles(): string[] { return Object.keys(this.profiles); }
  exportProfile(name?: string): string { return JSON.stringify(name ? this.profiles[name] : this.active, null, 2); }
  importProfile(json: string): boolean {
    try {
      const p = JSON.parse(json) as BindingProfile;
      if (!p.name || !p.bindings) return false;
      this.profiles[p.name] = p; this.persist(); return true;
    } catch { return false; }
  }

  getActiveBindings(): BindingProfile { return structuredClone(this.active); }
  subscribe(cb: (p: BindingProfile) => void): () => void {
    this.listeners.add(cb); cb(this.getActiveBindings());
    return () => this.listeners.delete(cb);
  }

  private emit(): void { const snap = this.getActiveBindings(); this.listeners.forEach((cb) => cb(snap)); }
  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.profiles));
      localStorage.setItem(STATE_KEY, JSON.stringify(this.active));
    } catch { /* quota */ }
  }
  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) this.profiles = { default: this.profiles.default, ...JSON.parse(raw) };
      const state = localStorage.getItem(STATE_KEY);
      if (state) this.active = JSON.parse(state);
      else {
        const name = localStorage.getItem(ACTIVE_KEY);
        if (name && this.profiles[name]) this.active = structuredClone(this.profiles[name]);
      }
    } catch { /* keep defaults */ }
  }
}