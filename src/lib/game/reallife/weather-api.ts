/**
 * Section J / J_RealLife_Integration-00012, 00025:
 * Real-world local weather (OpenWeather API) → in-game weather state,
 * ambient soundscape, and controller rumble strength.
 *
 * OpenWeather's free tier (Current Weather) requires an API key stored
 * client-side. We deliberately do NOT hardcode a key — callers must
 * supply one (recommended: via Firebase Remote Config, Section I).
 *
 * Browser fetch is universal; the only failure modes are network /
 * rate-limit / bad key. On any failure, `fetchWeather()` resolves to
 * null and `mapToGameWeather()` returns a neutral default so the game
 * never blocks on external API availability.
 */

export type GameWeather =
  | "clear"
  | "cloudy"
  | "overcast"
  | "fog"
  | "drizzle"
  | "rain"
  | "heavy-rain"
  | "thunderstorm"
  | "snow"
  | "hail"
  | "windy"
  | "dust";

export interface OpenWeatherResponse {
  weather: Array<{ id: number; main: string; description: string }>;
  main: { temp: number; humidity: number; pressure: number };
  wind: { speed: number; deg: number };
  clouds: { all: number };
  visibility?: number;
  rain?: { "1h"?: number };
  snow?: { "1h"?: number };
  name: string;
}

export interface GameWeatherState {
  condition: GameWeather;
  temperatureC: number;
  humidity: number;
  windMps: number;
  visibilityKm: number;
  rainMmPerHour: number;
  snowMmPerHour: number;
  /** 0–1 — used to scale ambient rain/snow particle density. */
  intensity: number;
}

const DEFAULT: GameWeatherState = {
  condition: "clear",
  temperatureC: 20,
  humidity: 50,
  windMps: 2,
  visibilityKm: 10,
  rainMmPerHour: 0,
  snowMmPerHour: 0,
  intensity: 0,
};

export class WeatherMapper {
  private apiKey: string | null = null;
  private baseUrl = "https://api.openweathermap.org/data/2.5/weather";
  private lastFetch = 0;
  private cacheTtlMs = 10 * 60 * 1000; // 10 min
  private cached: GameWeatherState | null = null;

  setApiKey(key: string): void {
    this.apiKey = key.trim();
  }

  setCacheTtl(ms: number): void {
    this.cacheTtlMs = ms;
  }

  async fetchWeather(lat: number, lon: number): Promise<GameWeatherState | null> {
    if (Date.now() - this.lastFetch < this.cacheTtlMs && this.cached) {
      return this.cached;
    }
    if (!this.apiKey) {
      return null;
    }
    try {
      const url = `${this.baseUrl}?lat=${lat}&lon=${lon}&units=metric&appid=${this.apiKey}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data: OpenWeatherResponse = await res.json();
      const state = this.mapToGameWeather(data);
      this.cached = state;
      this.lastFetch = Date.now();
      return state;
    } catch {
      return null;
    }
  }

  /** Pure mapping from OpenWeather payload → game weather state. */
  mapToGameWeather(data: OpenWeatherResponse): GameWeatherState {
    const owId = data.weather[0]?.id ?? 800;
    const rain = data.rain?.["1h"] ?? 0;
    const snow = data.snow?.["1h"] ?? 0;
    const visKm = (data.visibility ?? 10_000) / 1000;

    let condition: GameWeather = "clear";
    if (owId >= 200 && owId < 300) condition = "thunderstorm";
    else if (owId >= 300 && owId < 500) condition = "drizzle";
    else if (owId >= 500 && owId < 600) condition = rain > 4 ? "heavy-rain" : "rain";
    else if (owId >= 600 && owId < 700) condition = "snow";
    else if (owId >= 700 && owId < 800) {
      condition = owId === 731 || owId === 761 ? "dust" : "fog";
    } else if (owId === 801 || owId === 802) condition = "cloudy";
    else if (owId === 803 || owId === 804) condition = "overcast";

    if (data.wind.speed > 10) condition = "windy";

    const intensity = Math.min(
      1,
      Math.max(rain / 8, snow / 4, (100 - visKm * 10) / 100, 0),
    );

    return {
      condition,
      temperatureC: data.main.temp,
      humidity: data.main.humidity,
      windMps: data.wind.speed,
      visibilityKm: visKm,
      rainMmPerHour: rain,
      snowMmPerHour: snow,
      intensity,
    };
  }

  getDefault(): GameWeatherState {
    return { ...DEFAULT };
  }
}

export const weatherMapper = new WeatherMapper();
