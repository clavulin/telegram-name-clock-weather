// Typed view over wrangler `vars` + secrets. Mirrors the original .env knobs.
// Bindings (CLOCK) live alongside the scalar config on the same Env object.

import type { ClockDurableObject } from "./clock-do";
import { normalizeUnicodeStyle, type UnicodeStyle } from "./unicode-style";

export interface Env extends Cloudflare.Env {
  // Previous deployed Worker uses CLOCK_SCHEDULER/ClockScheduler. Keep this
  // optional alias so local tests can still provide a CLOCK namespace.
  CLOCK?: DurableObjectNamespace<ClockDurableObject>;

  // --- Secrets (wrangler secret put / .dev.vars) ---
  BASE_NAME?: string;
  TG_API_ID?: string;
  TG_API_HASH?: string;
  TG_STRING_SESSION?: string;
  CONTROL_TOKEN?: string;
  QW_HOST?: string;
  QW_LOCATION?: string;
  QW_PROJECT_ID?: string;
  QW_KEY_ID?: string;
  QW_JWT_KID?: string;
  QW_PRIVATE_KEY?: string;
  QW_JWT_PRIVATE_KEY?: string;
  QW_JWT_TTL_SECONDS?: string;
  QW_JWT?: string;
  QW_API_KEY?: string;
}

/** Resolved, validated config used by the loop. Built once per alarm tick. */
export interface ResolvedConfig {
  baseName: string;
  tzName: string;
  timeFormat: string;
  timeStyle: UnicodeStyle;
  tempStyle: UnicodeStyle;
  aheadSeconds: number;
  guardSeconds: number;
  weatherEnabled: boolean;
  weatherRefreshSeconds: number;
}

function readEnv(env: Env, name: keyof Env, fallback = ""): string {
  const value = env[name];
  return (typeof value === "string" ? value : fallback).trim();
}

function requireEnv(env: Env, name: keyof Env): string {
  const value = readEnv(env, name);
  if (!value) {
    throw new Error(`${String(name)} is required`);
  }
  return value;
}

function parseNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number`);
  }
  return parsed;
}

function parseBoolean(value: string): boolean {
  return !["0", "false", "False"].includes(value.trim());
}

export function resolveConfig(env: Env): ResolvedConfig {
  const baseName = requireEnv(env, "BASE_NAME");
  requireEnv(env, "TG_API_ID");
  requireEnv(env, "TG_API_HASH");
  requireEnv(env, "TG_STRING_SESSION");

  const aheadSeconds = parseNumber(readEnv(env, "AHEAD_SECONDS", "0"), "AHEAD_SECONDS");
  const guardSeconds = parseNumber(readEnv(env, "GUARD_SECONDS", "0.15"), "GUARD_SECONDS");
  if (guardSeconds < 0 || guardSeconds >= 60) {
    throw new Error("GUARD_SECONDS must be >= 0 and < 60");
  }
  const weatherRefreshSeconds = Math.max(
    parseNumber(readEnv(env, "WEATHER_REFRESH_SECONDS", "1800"), "WEATHER_REFRESH_SECONDS"),
    60,
  );

  return {
    baseName,
    tzName: readEnv(env, "TZ_NAME", "Australia/Sydney") || "Australia/Sydney",
    timeFormat: readEnv(env, "TIME_FORMAT", "{time}") || "{time}",
    timeStyle: normalizeUnicodeStyle(readEnv(env, "TIME_STYLE", "fancy"), "TIME_STYLE"),
    tempStyle: normalizeUnicodeStyle(readEnv(env, "TEMP_STYLE", "fancy"), "TEMP_STYLE"),
    aheadSeconds,
    guardSeconds,
    weatherEnabled: parseBoolean(readEnv(env, "WEATHER_ENABLED", "1") || "1"),
    weatherRefreshSeconds,
  };
}
