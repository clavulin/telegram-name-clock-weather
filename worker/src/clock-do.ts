// ClockDurableObject — the long-lived clock loop, ported from main.py's
// `while True` loop into an alarm-driven Durable Object.
//
// Why a DO instead of a plain cron Worker:
//   * alarm() can fire at a precise instant, so we can reproduce the original
//     AHEAD_SECONDS / GUARD_SECONDS / next_fire_time minute-boundary alignment.
//     A `* * * * *` cron only fires near :00 and cannot do sub-minute targeting.
  //   * ctx.storage persists last_name + weather cache + alarm state, and a
//     single DO instance serializes everything (no concurrent rename races).
//
// IMPORTANT — connection lifetime:
//   Outbound TCP sockets do NOT hibernate (only inbound WS servers do), and any
//   live GramJS timer would keep this DO pinned in memory (continuous GB-s
//   billing). So we deliberately DROP the connection at the end of every tick
//   (see releaseClient in the alarm() finally) and reconnect on the next tick
//   from the persisted StringSession. `this.client` is only a within-tick handle.

import { DurableObject } from "cloudflare:workers";
import type { Env, ResolvedConfig } from "./config";
import { resolveConfig } from "./config";
import { connectTelegram, type TelegramClientHandle } from "./telegram";
import { computeTargetHhmm, nextFireTimeMs } from "./time";
import { formatUnicodeStyle } from "./unicode-style";
import { fetchWeather } from "./weather";

export interface PersistedState {
  lastTargetHhmm: string | null;
  lastSetName: string | null;
  weatherText: string; // e.g. "☁️25℃"
  nextWeatherFetchMs: number;
}

export type ClockStatus = PersistedState & { alarmAt: number | null };

const STATE_KEY = "state";
const MAX_TELEGRAM_NAME_LENGTH = 64;
const GENERIC_RETRY_MS = 5000;

export function clampName(value: string, maxLength = MAX_TELEGRAM_NAME_LENGTH): string {
  return [...value].slice(0, maxLength).join("");
}

export function floodWaitSeconds(err: unknown): number | null {
  const maybeSeconds = (err as { seconds?: unknown })?.seconds;
  if (typeof maybeSeconds === "number" && Number.isFinite(maybeSeconds)) {
    return Math.max(0, Math.floor(maybeSeconds));
  }

  const message = err instanceof Error ? err.message : String(err);
  const match = /FLOOD_WAIT_?(\d+)/i.exec(message);
  return match?.[1] ? Number(match[1]) : null;
}

export class ClockDurableObject extends DurableObject<Env> {
  // Warm, non-durable connection cache (lost on eviction — see file header).
  private client: TelegramClientHandle | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  /** Arm the alarm if not already scheduled. Idempotent; safe to call repeatedly. */
  async start(): Promise<void> {
    const cfg = resolveConfig(this.env);
    const current = await this.ctx.storage.getAlarm();
    if (current === null) {
      const now = Date.now();
      const fireAt = Math.max(nextFireTimeMs(now, cfg.aheadSeconds, cfg.guardSeconds), now + 1000);
      await this.ctx.storage.setAlarm(fireAt);
    }
  }

  /** Debug snapshot for GET /status. */
  async status(): Promise<ClockStatus> {
    return {
      ...(await this.loadState()),
      alarmAt: await this.ctx.storage.getAlarm(),
    };
  }

  // The heart of the loop: one tick == one minute boundary. Ported from the body
  // of main.py's `while True` (lines 484-535), minus the busy-wait — alarm timing
  // replaces smart_sleep / next_fire_time spin.
  async alarm(): Promise<void> {
    const cfg: ResolvedConfig = resolveConfig(this.env);
    const state = await this.loadState();

    try {
      await this.waitForGuardWindow(cfg);
      const nowMs = Date.now();
      if (cfg.weatherEnabled && nowMs >= state.nextWeatherFetchMs) {
        try {
          const weather = await fetchWeather(this.env);
          state.weatherText = `${weather.emoji}${formatUnicodeStyle(`${weather.tempC}°C`, cfg.tempStyle, true)}`;
          console.log(`[WEATHER] Updated -> ${state.weatherText}`);
        } catch (err) {
          console.warn(`[WEATHER_ERR] ${err instanceof Error ? err.message : String(err)} (keeping last: '${state.weatherText}')`);
        }
        state.nextWeatherFetchMs = nowMs + cfg.weatherRefreshSeconds * 1000;
        await this.saveState(state);
      }

      const targetHhmm = computeTargetHhmm(nowMs, cfg.aheadSeconds, cfg.tzName);
      if (targetHhmm !== state.lastTargetHhmm) {
        const plainTime = cfg.timeFormat.replaceAll("{time}", targetHhmm).trim();
        const timePart = formatUnicodeStyle(plainTime, cfg.timeStyle, true);
        const nameParts = [cfg.baseName, timePart];
        if (cfg.weatherEnabled && state.weatherText) nameParts.push(state.weatherText);

        const newName = clampName(nameParts.join(" "));
        if (newName !== state.lastSetName) {
          if (cfg.dryRun) {
            // Dry run: never touch the real account or open a Telegram socket.
            console.log(`[DRY] Would set name -> ${newName}`);
            state.lastSetName = newName;
          } else {
            console.log(`[TRY] Setting name -> ${newName}`);
            const client = await this.getClient();
            state.lastSetName = await client.updateProfileName(newName);
            console.log(`[CONFIRM] Telegram now shows -> ${state.lastSetName}`);
          }
        }
        state.lastTargetHhmm = targetHhmm;
      }

      await this.saveState(state);
      await this.scheduleNext(cfg);
    } catch (err) {
      const waitSeconds = floodWaitSeconds(err);
      if (waitSeconds !== null) {
        console.warn(`[FLOOD] Need to wait ${waitSeconds}s`);
        await this.ctx.storage.setAlarm(Date.now() + (waitSeconds + 1) * 1000);
        return;
      }

      console.error("[ERR]", err);
      await this.ctx.storage.setAlarm(Date.now() + GENERIC_RETRY_MS);
    } finally {
      // Close the MTProto socket after every tick so no GramJS timer keeps the
      // Durable Object pinned in memory between minutes. The next tick reconnects
      // from the persisted StringSession (cheap — the auth key is reused).
      await this.releaseClient();
    }
  }

  private async releaseClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await client.disconnect();
    } catch (err) {
      console.warn(`[DISCONNECT_WARN] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async loadState(): Promise<PersistedState> {
    const stored = await this.ctx.storage.get<Partial<PersistedState>>(STATE_KEY);
    return {
      lastTargetHhmm: stored?.lastTargetHhmm ?? null,
      lastSetName: stored?.lastSetName ?? null,
      weatherText: stored?.weatherText ?? "",
      nextWeatherFetchMs: stored?.nextWeatherFetchMs ?? 0,
    };
  }

  private async saveState(state: PersistedState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state);
  }

  private async scheduleNext(cfg: ResolvedConfig): Promise<void> {
    const now = Date.now();
    await this.ctx.storage.setAlarm(Math.max(nextFireTimeMs(now, cfg.aheadSeconds, cfg.guardSeconds), now + 1000));
  }

  private async waitForGuardWindow(cfg: ResolvedConfig): Promise<void> {
    const guardMs = cfg.guardSeconds * 1000;
    if (guardMs <= 0) return;

    const now = Date.now();
    const boundaryMs = nextFireTimeMs(now, cfg.aheadSeconds);
    const delayMs = boundaryMs - now;
    if (delayMs > 0 && delayMs <= guardMs + 1000) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  private async getClient(): Promise<TelegramClientHandle> {
    if (this.client?.isConnected()) return this.client;
    // Drop any stale handle before replacing it so we never leak a dead socket.
    await this.releaseClient();
    this.client = await connectTelegram(this.env);
    return this.client;
  }
}
