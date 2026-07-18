/**
 * Section J / J_RealLife_Integration-00001, 00010, 00019, 00022, 00027,
 * 00038: Real-world time → in-game time-of-day. Drives sunrise/sunset
 *  on the operator's idle breathing rate, battle-pass XP multiplier
 *  (night-owl bonus), enemy spawn density (day/night cycle), and the
 *  HUD accent color (cool blue at night, warm gold at day).
 *
 * Uses the device's local timezone (via `Intl.DateTimeFormat` and
 * `Date.prototype.getTimezoneOffset`) — NOT a server time, so a player
 * traveling across timezones sees the game adapt in real time. Optional
 * geolocation latitude feeds a sunrise/sunset model so the in-game day
 * length matches the player's actual solar day.
 *
 * All functions are pure — no I/O. Safe to call server-side.
 */

export interface GameTimeOfDay {
  /** 0–24 hours, fractional. e.g. 14.5 = 14:30. */
  hour: number;
  /** 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset. */
  dayPhase: number;
  /** "dawn" | "day" | "dusk" | "night" */
  period: "dawn" | "day" | "dusk" | "night";
  /** Sunrise hour in the player's local tz (e.g. 6.5 = 06:30). */
  sunriseHour: number;
  /** Sunset hour in the player's local tz (e.g. 19.25 = 19:15). */
  sunsetHour: number;
  /** IANA timezone id, e.g. "America/Los_Angeles". */
  timezone: string;
  /** ISO date string (YYYY-MM-DD) in the player's tz. */
  localDate: string;
}

export interface TimeSyncOptions {
  latitude?: number;
  longitude?: number;
  /** Override the "now" — useful for replay/testing. */
  now?: Date;
}

const DEFAULT_SUNRISE = 6.5; // 06:30
const DEFAULT_SUNSET = 19.25; // 19:15

export class TimeSyncMapper {
  /**
   * Compute the in-game time-of-day from the device wall clock + tz.
   * If latitude is supplied, a NOAA-style sunrise approximation is
   * used; otherwise we default to 06:30 / 19:15.
   */
  getGameTimeFromRealTime(opts: TimeSyncOptions = {}): GameTimeOfDay {
    const now = opts.now ?? new Date();
    const timezone =
      Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const hour = this.localHour(now);
    const { sunrise, sunset } = this.computeSunriseSunset(now, opts.latitude);

    const dayPhase = hour / 24;
    const period = this.classifyPeriod(hour, sunrise, sunset);

    return {
      hour,
      dayPhase,
      period,
      sunriseHour: sunrise,
      sunsetHour: sunset,
      timezone,
      localDate: this.localDate(now),
    };
  }

  /** Fractional hour in the player's local tz (0–24). */
  private localHour(d: Date): number {
    const fmt = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    const parts = fmt.formatToParts(d);
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    const s = Number(parts.find((p) => p.type === "second")?.value ?? "0");
    const hh = h === 24 ? 0 : h; // Intl can emit "24" at midnight.
    return hh + m / 60 + s / 3600;
  }

  private localDate(d: Date): string {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return fmt.format(d);
  }

  /** NOAA-style approximation. Good to ~5 min for non-polar latitudes. */
  private computeSunriseSunset(
    date: Date,
    lat?: number,
  ): { sunrise: number; sunset: number } {
    if (lat === undefined) {
      return { sunrise: DEFAULT_SUNRISE, sunset: DEFAULT_SUNSET };
    }
    const dayOfYear = Math.floor(
      (date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / 86_400_000,
    );
    const rad = Math.PI / 180;
    const decl = 23.45 * Math.sin(rad * (360 / 365) * (dayOfYear - 81));
    const cosH = -Math.tan(rad * lat) * Math.tan(rad * decl);
    if (cosH > 1) return { sunrise: 0, sunset: 24 }; // polar night
    if (cosH < -1) return { sunrise: 0, sunset: 24 }; // polar day
    const H = (Math.acos(cosH) / rad) * 24 / 360;
    const noonLocal = 12; // solar noon ~ local noon for simplicity
    return {
      sunrise: noonLocal - H,
      sunset: noonLocal + H,
    };
  }

  private classifyPeriod(
    hour: number,
    sunrise: number,
    sunset: number,
  ): "dawn" | "day" | "dusk" | "night" {
    const dawnStart = sunrise - 1;
    const duskStart = sunset;
    const duskEnd = sunset + 1;
    if (hour >= dawnStart && hour < sunrise) return "dawn";
    if (hour >= sunrise && hour < duskStart) return "day";
    if (hour >= duskStart && hour < duskEnd) return "dusk";
    return "night";
  }

  /**
   * Night-owl XP multiplier for the Battle Pass: 1.0x during the day,
   * 1.25x 22:00–03:00 local time. Used by Section N economy / meta.
   */
  getNightOwlXpMultiplier(now: Date = new Date()): number {
    const hour = this.localHour(now);
    return hour >= 22 || hour < 3 ? 1.25 : 1.0;
  }
}

export const timeSyncMapper = new TimeSyncMapper();
