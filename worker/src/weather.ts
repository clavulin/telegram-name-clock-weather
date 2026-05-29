// Weather: QWeather (preferred when configured) with Open-Meteo fallback.
// HTTP via fetch() — direct port of the `requests` calls in main.py.
// The emoji maps below are pure and ported 1:1 from the Python implementation.

import type { Env } from "./config";
import { buildQweatherJwt } from "./qweather-jwt";

const WEATHER_FETCH_TIMEOUT_MS = 10_000;

export interface Weather {
  emoji: string;
  tempC: number;
}

/** Ported from qweather_emoji (main.py:229). */
export function qweatherEmoji(iconCode: string): string {
  const code = Number.parseInt(iconCode, 10);
  if (Number.isNaN(code)) return "☁️";

  if (code === 100) return "☀️";
  if (code === 150) return "🌙";
  if ([102, 103, 152, 153].includes(code)) return "🌤️";
  if ((code >= 101 && code <= 104) || (code >= 151 && code <= 154)) return "☁️";
  if (code >= 500 && code <= 515) return "🌫️";
  if (code >= 300 && code <= 399) return code === 302 || code === 303 ? "⛈️" : "🌧️";
  if (code >= 400 && code <= 499) return "🌨️";
  return "☁️";
}

/** Ported from open_meteo_emoji (main.py:271). WMO weather codes. */
export function openMeteoEmoji(weatherCode: number, isDay?: number): string {
  if (weatherCode === 0) return isDay ? "☀️" : "🌙";
  if (weatherCode === 1 || weatherCode === 2) return isDay ? "🌤️" : "☁️";
  if (weatherCode === 3) return "☁️";
  if (weatherCode === 45 || weatherCode === 48) return "🌫️";
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(weatherCode)) return "🌧️";
  if ([71, 73, 75, 77, 85, 86].includes(weatherCode)) return "🌨️";
  if ([95, 96, 99].includes(weatherCode)) return "⛈️";
  return "☁️";
}

export function qweatherAuthConfigured(env: Env): boolean {
  return Boolean(env.QW_API_KEY || env.QW_JWT || qweatherDynamicAuthConfigured(env));
}

export function qweatherDynamicAuthConfigured(env: Env): boolean {
  return Boolean(env.QW_PROJECT_ID && (env.QW_KEY_ID || env.QW_JWT_KID) && (env.QW_PRIVATE_KEY || env.QW_JWT_PRIVATE_KEY));
}

export function parseLonLat(value: string): { lon: number; lat: number } {
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length !== 2) {
    throw new Error("expected lon,lat");
  }

  const lon = Number(parts[0]);
  const lat = Number(parts[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    throw new Error("longitude/latitude must be numbers");
  }
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
    throw new Error("longitude/latitude out of range");
  }
  return { lon, lat };
}

export function openMeteoCoordinates(env: Env): { lat: number; lon: number } {
  const latText = env.OPEN_METEO_LATITUDE?.trim() ?? "";
  const lonText = env.OPEN_METEO_LONGITUDE?.trim() ?? "";
  if (Boolean(latText) !== Boolean(lonText)) {
    throw new Error("OPEN_METEO_LATITUDE and OPEN_METEO_LONGITUDE must be set together");
  }

  if (latText && lonText) {
    const lat = Number(latText);
    const lon = Number(lonText);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error("Open-Meteo latitude/longitude must be numbers");
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw new Error("Open-Meteo latitude/longitude out of range");
    }
    return { lat, lon };
  }

  const { lon, lat } = parseLonLat(env.QW_LOCATION?.trim() ?? "");
  return { lat, lon };
}

function requireText(value: string | undefined, name: string): string {
  const text = value?.trim() ?? "";
  if (!text) throw new Error(`${name} is required`);
  return text;
}

async function readJson(response: Response, label: string): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`${label} HTTP ${response.status}`);
  }
  return response.json();
}

async function fetchJson(url: URL, label: string, init: RequestInit = {}): Promise<unknown> {
  return readJson(
    await fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(WEATHER_FETCH_TIMEOUT_MS),
    }),
    label,
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export async function fetchWeatherQweather(env: Env): Promise<Weather> {
  const host = requireText(env.QW_HOST, "QW_HOST").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const location = requireText(env.QW_LOCATION, "QW_LOCATION");
  const jwtToken = qweatherDynamicAuthConfigured(env) ? await buildQweatherJwt(env) : env.QW_JWT?.trim() ?? "";
  const apiKey = env.QW_API_KEY?.trim() ?? "";
  if (!jwtToken && !apiKey) {
    throw new Error("Need dynamic JWT envs, QW_JWT, or QW_API_KEY for QWeather");
  }

  const url = new URL(`https://${host}/v7/weather/now`);
  url.searchParams.set("location", location);
  url.searchParams.set("lang", env.QW_LANG?.trim() || "zh");
  url.searchParams.set("unit", env.QW_UNIT?.trim() || "m");

  const headers = new Headers();
  if (jwtToken) {
    headers.set("Authorization", `Bearer ${jwtToken}`);
  } else {
    headers.set("X-QW-Api-Key", apiKey);
  }

  const data = asRecord(await fetchJson(url, "QWeather", { headers }));
  if (data.code !== "200") {
    throw new Error(`QWeather error code=${String(data.code)}`);
  }

  const now = asRecord(data.now);
  const temp = now.temp;
  const icon = now.icon;
  if (temp === undefined || icon === undefined) {
    throw new Error("QWeather response missing now.temp/now.icon");
  }

  const tempC = Number(temp);
  if (!Number.isFinite(tempC)) {
    throw new Error("QWeather response now.temp is not numeric");
  }
  return { emoji: qweatherEmoji(String(icon)), tempC: Math.round(tempC) };
}

export async function fetchWeatherOpenMeteo(env: Env): Promise<Weather> {
  const { lat, lon } = openMeteoCoordinates(env);
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("current", "temperature_2m,weather_code,is_day");
  url.searchParams.set("temperature_unit", "celsius");
  url.searchParams.set("timezone", "auto");

  const data = asRecord(await fetchJson(url, "Open-Meteo"));
  const current = asRecord(data.current);
  const temp = current.temperature_2m;
  const weatherCode = current.weather_code;
  if (temp === undefined || weatherCode === undefined) {
    throw new Error("Open-Meteo response missing current.temperature_2m/current.weather_code");
  }

  const tempC = Number(temp);
  const code = Number(weatherCode);
  if (!Number.isFinite(tempC) || !Number.isFinite(code)) {
    throw new Error("Open-Meteo response temperature/weather_code is not numeric");
  }
  return { emoji: openMeteoEmoji(code, Number(current.is_day)), tempC: Math.round(tempC) };
}

export async function fetchWeather(env: Env): Promise<Weather> {
  if (qweatherAuthConfigured(env)) {
    try {
      return await fetchWeatherQweather(env);
    } catch (err) {
      try {
        const fallback = await fetchWeatherOpenMeteo(env);
        console.warn(`[WEATHER_WARN] QWeather failed (${err instanceof Error ? err.message : String(err)}); used Open-Meteo fallback`);
        return fallback;
      } catch (fallbackErr) {
        throw new Error(
          `QWeather failed (${err instanceof Error ? err.message : String(err)}); ` +
            `Open-Meteo fallback also failed (${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)})`,
        );
      }
    }
  }

  return fetchWeatherOpenMeteo(env);
}
