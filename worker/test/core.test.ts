import { describe, expect, it, vi, afterEach } from "vitest";
import worker from "../src/index";
import { clampName, floodWaitSeconds } from "../src/clock-do";
import type { Env } from "../src/config";
import { resolveConfig } from "../src/config";
import { base64UrlEncode, buildQweatherJwt } from "../src/qweather-jwt";
import { nextFireTimeMs } from "../src/time";
import { formatUnicodeStyle, normalizeUnicodeStyle } from "../src/unicode-style";
import {
  fetchWeather,
  fetchWeatherOpenMeteo,
  openMeteoCoordinates,
  parseLonLat,
} from "../src/weather";

function env(overrides: Partial<Env> = {}): Env {
  return {
    CLOCK: undefined as unknown as Env["CLOCK"],
    CLOCK_SCHEDULER: undefined as unknown as Env["CLOCK_SCHEDULER"],
    BASE_NAME: "Alice",
    TZ_NAME: "Australia/Sydney",
    TIME_FORMAT: "{time}",
    TIME_STYLE: "fancy",
    TEMP_STYLE: "fancy",
    AHEAD_SECONDS: "0",
    GUARD_SECONDS: "0.15",
    WEATHER_ENABLED: "1",
    WEATHER_REFRESH_SECONDS: "1800",
    QW_HOST: "",
    QW_LOCATION: "121.47,31.23",
    QW_LANG: "en",
    QW_UNIT: "m",
    OPEN_METEO_LATITUDE: "",
    OPEN_METEO_LONGITUDE: "",
    TG_API_ID: "12345",
    TG_API_HASH: "hash",
    TG_STRING_SESSION: "session",
    CONTROL_TOKEN: "secret",
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveConfig", () => {
  it("parses defaults and normalizes styles", () => {
    expect(resolveConfig(env())).toMatchObject({
      baseName: "Alice",
      tzName: "Australia/Sydney",
      timeFormat: "{time}",
      timeStyle: "bold",
      tempStyle: "bold",
      aheadSeconds: 0,
      guardSeconds: 0.15,
      weatherEnabled: true,
      weatherRefreshSeconds: 1800,
    });
  });

  it("validates required values and clamps weather refresh", () => {
    expect(() => resolveConfig(env({ BASE_NAME: "" }))).toThrow(/BASE_NAME/);
    expect(() => resolveConfig(env({ TG_API_ID: "" }))).toThrow(/TG_API_ID/);
    expect(() => resolveConfig(env({ GUARD_SECONDS: "-0.1" }))).toThrow(/GUARD_SECONDS/);
    expect(resolveConfig(env({ WEATHER_ENABLED: "False", WEATHER_REFRESH_SECONDS: "5" }))).toMatchObject({
      weatherEnabled: false,
      weatherRefreshSeconds: 60,
    });
  });
});

describe("unicode styling", () => {
  it("normalizes aliases", () => {
    expect(normalizeUnicodeStyle("fancy", "TIME_STYLE")).toBe("bold");
    expect(normalizeUnicodeStyle("sans-serif-bold", "TIME_STYLE")).toBe("sans_bold");
    expect(normalizeUnicodeStyle("mono", "TIME_STYLE")).toBe("monospace");
  });

  it("matches README preview samples", () => {
    expect(formatUnicodeStyle("13:51", "bold", true)).toBe("𝟏𝟑:𝟓𝟏");
    expect(formatUnicodeStyle("20°C", "bold", true)).toBe("𝟐𝟎°𝐂");
    expect(formatUnicodeStyle("13:51", "double_struck", true)).toBe("𝟙𝟛:𝟝𝟙");
    expect(formatUnicodeStyle("20°C", "double_struck", true)).toBe("𝟚𝟘°ℂ");
    expect(formatUnicodeStyle("20°C", "italic", true)).toBe("20°𝐶");
  });
});

describe("qweather jwt", () => {
  it("base64url encodes without padding", () => {
    expect(base64UrlEncode(new TextEncoder().encode("?foo"))).toBe("P2Zvbw");
  });

  it("builds a verifiable Ed25519 JWT", async () => {
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
    const token = await buildQweatherJwt(
      env({
        QW_PROJECT_ID: "project",
        QW_KEY_ID: "kid",
        QW_PRIVATE_KEY: btoa(String.fromCharCode(...new Uint8Array(pkcs8))),
        QW_JWT_TTL_SECONDS: "900",
      }),
      1_700_000_000,
    );

    const [header, payload, signature] = token.split(".");
    expect(JSON.parse(new TextDecoder().decode(base64UrlDecode(header ?? "")))).toEqual({ alg: "EdDSA", kid: "kid" });
    expect(JSON.parse(new TextDecoder().decode(base64UrlDecode(payload ?? "")))).toEqual({
      sub: "project",
      iat: 1_699_999_970,
      exp: 1_700_000_870,
    });
    await expect(
      crypto.subtle.verify("Ed25519", keys.publicKey, base64UrlDecode(signature ?? ""), new TextEncoder().encode(`${header}.${payload}`)),
    ).resolves.toBe(true);
  });

  it("accepts the deployed QWeather legacy secret names", async () => {
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
    const token = await buildQweatherJwt(
      env({
        QW_PROJECT_ID: "project",
        QW_JWT_KID: "legacy-kid",
        QW_JWT_PRIVATE_KEY: btoa(String.fromCharCode(...new Uint8Array(pkcs8))),
      }),
      1_700_000_000,
    );

    const [header] = token.split(".");
    expect(JSON.parse(new TextDecoder().decode(base64UrlDecode(header ?? "")))).toEqual({ alg: "EdDSA", kid: "legacy-kid" });
  });
});

describe("weather", () => {
  it("parses coordinates", () => {
    expect(parseLonLat("121.47,31.23")).toEqual({ lon: 121.47, lat: 31.23 });
    expect(() => parseLonLat("31.23")).toThrow(/expected lon,lat/);
    expect(openMeteoCoordinates(env({ OPEN_METEO_LATITUDE: "1.5", OPEN_METEO_LONGITUDE: "2.5" }))).toEqual({
      lat: 1.5,
      lon: 2.5,
    });
  });

  it("fetches Open-Meteo weather", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ current: { temperature_2m: 19.6, weather_code: 0, is_day: 1 } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWeatherOpenMeteo(env())).resolves.toEqual({ emoji: "☀️", tempC: 20 });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("api.open-meteo.com/v1/forecast");
  });

  it("falls back from QWeather to Open-Meteo", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: "401" }))
      .mockResolvedValueOnce(jsonResponse({ current: { temperature_2m: 21.4, weather_code: 95, is_day: 1 } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWeather(env({ QW_HOST: "weather.example", QW_API_KEY: "key" }))).resolves.toEqual({
      emoji: "⛈️",
      tempC: 21,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("clock helpers and routes", () => {
  it("clamps names and classifies flood waits", () => {
    expect(clampName("a".repeat(65))).toHaveLength(64);
    expect([...clampName("😀".repeat(65))]).toHaveLength(64);
    expect(clampName("😀".repeat(65))).not.toContain("�");
    expect(floodWaitSeconds({ seconds: 42 })).toBe(42);
    expect(floodWaitSeconds(new Error("FLOOD_WAIT_17"))).toBe(17);
    expect(floodWaitSeconds(new Error("other"))).toBeNull();
  });

  it("schedules early by the configured guard window", () => {
    expect(nextFireTimeMs(30_000, 0, 0.2)).toBe(59_800);
  });

  it("routes start and status through the singleton Durable Object stub", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const status = vi.fn().mockResolvedValue({
      lastTargetHhmm: null,
      lastSetName: "Alice",
      weatherText: "☀️𝟐𝟎°𝐂",
      nextWeatherFetchMs: 123,
      alarmAt: 456,
    });
    const fakeEnv = env({
      CLOCK_SCHEDULER: {
        getByName: vi.fn(() => ({ start, status })),
      } as unknown as Env["CLOCK_SCHEDULER"],
    });

    const startResponse = await worker.fetch(
      new Request("https://worker.test/start", { headers: { authorization: "Bearer secret" } }),
      fakeEnv,
    );
    await expect(startResponse.json()).resolves.toEqual({ ok: true, alarmAt: 456 });
    expect(start).toHaveBeenCalledTimes(1);

    const statusResponse = await worker.fetch(
      new Request("https://worker.test/status", { headers: { authorization: "Bearer secret" } }),
      fakeEnv,
    );
    await expect(statusResponse.json()).resolves.toMatchObject({ lastSetName: "Alice", alarmAt: 456 });
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("protects control routes with CONTROL_TOKEN", async () => {
    await expect(worker.fetch(new Request("https://worker.test/status"), env())).resolves.toMatchObject({ status: 401 });
    await expect(worker.fetch(new Request("https://worker.test/status"), env({ CONTROL_TOKEN: "" }))).resolves.toMatchObject({
      status: 503,
    });
  });
});
