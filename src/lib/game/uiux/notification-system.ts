/**
 * Section K — Smart Notification System (toasts, achievements, match events).
 * Priority-aware queue with dedup, throttling and auto-expiry.
 * Public API: `NotificationSystem`, `Notification`, `NotificationKind`.
 */

export type NotificationKind =
  | "toast" | "achievement" | "matchEvent" | "killstreak" | "social" | "system";

export type NotificationSeverity = "info" | "success" | "warning" | "error";

export interface Notification {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body?: string;
  icon?: string;
  ttl: number;
  createdAt: number;
  fingerprint?: string;
  action?: { label: string; href?: string; onClick?: () => void };
}

export interface NotificationOptions {
  kind?: NotificationKind;
  severity?: NotificationSeverity;
  ttl?: number;
  fingerprint?: string;
  icon?: string;
  action?: Notification["action"];
}

const DEFAULT_TTL: Record<NotificationKind, number> = {
  toast: 4000, achievement: 8000, matchEvent: 5000,
  killstreak: 3500, social: 5000, system: 6000,
};
const PRIORITY: Record<NotificationSeverity, number> = { error: 4, warning: 3, success: 2, info: 1 };

export class NotificationSystem {
  private items: Notification[] = [];
  private listeners = new Set<(items: Notification[]) => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastFingerprintAt = new Map<string, number>();
  private rateLimitMs = 250;

  setRateLimit(ms: number): void { this.rateLimitMs = ms; }

  push(title: string, body?: string, opts: NotificationOptions = {}): Notification {
    const kind = opts.kind ?? "toast";
    const fp = opts.fingerprint;
    if (fp) {
      const last = this.lastFingerprintAt.get(fp) ?? 0;
      if (Date.now() - last < this.rateLimitMs) {
        const existing = this.items.find((n) => n.fingerprint === fp);
        if (existing) this.dismiss(existing.id);
      }
      this.lastFingerprintAt.set(fp, Date.now());
    }
    const n: Notification = {
      id: `n_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      kind, severity: opts.severity ?? "info", title, body, icon: opts.icon,
      ttl: opts.ttl ?? DEFAULT_TTL[kind], createdAt: Date.now(),
      fingerprint: fp, action: opts.action,
    };
    this.items.push(n);
    if (n.ttl > 0) this.scheduleExpiry(n);
    if (this.items.length > 12) {
      this.items.sort((a, b) => b.createdAt - a.createdAt);
      this.items = this.items.slice(0, 12);
    }
    this.emit();
    return n;
  }

  dismiss(id: string): void {
    const t = this.timers.get(id);
    if (t) { clearTimeout(t); this.timers.delete(id); }
    this.items = this.items.filter((n) => n.id !== id);
    this.emit();
  }

  clear(): void {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    this.items = [];
    this.emit();
  }

  list(): Notification[] { return [...this.items]; }

  subscribe(cb: (items: Notification[]) => void): () => void {
    this.listeners.add(cb);
    cb(this.list());
    return () => this.listeners.delete(cb);
  }

  toast(title: string, body?: string, opts: NotificationOptions = {}): Notification {
    return this.push(title, body, { ...opts, kind: opts.kind ?? "toast" });
  }
  achievement(title: string, body?: string): Notification {
    return this.push(title, body, { kind: "achievement", severity: "success" });
  }
  matchEvent(title: string, body?: string, severity: NotificationSeverity = "info"): Notification {
    return this.push(title, body, { kind: "matchEvent", severity });
  }
  killstreak(count: number): Notification {
    return this.push(`${count} Killstreak`, `You're on a ${count} kill streak`, {
      kind: "killstreak", severity: "success", fingerprint: `ks_${count}`,
    });
  }

  private scheduleExpiry(n: Notification): void {
    const t = setTimeout(() => this.dismiss(n.id), n.ttl);
    this.timers.set(n.id, t);
  }

  private emit(): void {
    const sorted = [...this.items].sort(
      (a, b) => PRIORITY[b.severity] - PRIORITY[a.severity] || b.createdAt - a.createdAt,
    );
    this.listeners.forEach((cb) => cb(sorted));
  }
}
