# Cloudflare Worker port — plan & runbook

Port of the root `main.py` daemon to a Cloudflare **Durable Object** (alarm-driven).
This directory is a self-contained Worker; the Python app at the repo root is untouched.
Wrangler is configured for the existing Cloudflare Worker project `telegram-name-clock`.

## Why a Durable Object (not a plain cron Worker)

- **Precise scheduling.** The DO `alarm()` fires at an exact instant, so we reproduce
  the original `AHEAD_SECONDS` / `GUARD_SECONDS` / `next_fire_time` minute-boundary
  alignment. A `* * * * *` cron only fires near `:00` and can't do sub-minute targeting.
- **Durable, serialized state.** `ctx.storage` holds `last_name` + weather cache; a
  single DO instance means no concurrent rename races.

## Known constraint (be honest about it)

Outbound TCP sockets **do not hibernate** (only inbound WebSocket *servers* do). When
the DO is evicted from memory the MTProto socket dies. So:

- `this.client` is a **warm cache**, not a guaranteed-persistent connection: reuse it
  when connected, reconnect otherwise. Alarms ~every minute usually keep the DO warm.
- A truly always-connected DO would have to stay pinned 24/7 → continuous GB-s billing
  (≈ an always-on tiny server, *more* expensive than the original VPS/container). We
  deliberately do **not** do that; reconnect-as-needed is the chosen trade-off.

## The two hard porting problems

1. **MTProto user session.** Changing your own account `first_name` requires MTProto
   (Bot API can't). We use **GramJS** (`telegram`). Its `StringSession` is **not**
   compatible with the Python/Telethon session — regenerate via `npm run login`.
2. **Unicode styling.** Python used `unicodedata.lookup` by glyph *name*; JS has no name
   DB. Strategy: **codegen** a static `{codepoint -> glyph}` table per style from the
   Python maps, then do a plain table replace. See `src/unicode-style.ts` header.

## What ports cleanly

- Weather emoji maps + Open-Meteo/QWeather HTTP → `fetch` (`src/weather.ts`).
- QWeather EdDSA JWT → Web Crypto `Ed25519` (`src/qweather-jwt.ts`), no deps.
- Time/boundary math → `Intl.DateTimeFormat` + epoch arithmetic (`src/time.ts`, done).

## File map

| File | Role | Status |
|---|---|---|
| `src/index.ts` | Worker entry, routes `/start` `/status` to the DO | implemented |
| `src/clock-do.ts` | `ClockDurableObject` — the alarm loop (was `while True`) | implemented |
| `src/config.ts` | `Env` + `resolveConfig` (was env parsing in `main()`) | implemented |
| `src/time.ts` | `computeTargetHhmm` / `nextFireTimeMs` | **ported** |
| `src/weather.ts` | QWeather, Open-Meteo, and fallback fetch glue | implemented |
| `src/qweather-jwt.ts` | Ed25519 JWT via Web Crypto | implemented |
| `src/unicode-style.ts` | style normalize + static glyph tables | implemented |
| `src/telegram.ts` | GramJS MTProto wrapper | implemented |
| `scripts/login.mjs` | one-time GramJS session generator (plain Node) | usable |

## Setup / deploy

```bash
cd worker
npm install
npm run login                      # -> paste output into TG_STRING_SESSION

cp .dev.vars.example .dev.vars     # fill secrets for local dev
npm run dev                        # local; use Bearer auth for /start and /status

# production secrets
wrangler secret put TG_API_ID
wrangler secret put TG_API_HASH
wrangler secret put TG_STRING_SESSION
wrangler secret put CONTROL_TOKEN
# (+ QW_* if using QWeather)

# edit non-secret knobs in wrangler.jsonc [vars], then:
npm run deploy
curl -H "Authorization: Bearer $CONTROL_TOKEN" https://<worker>.workers.dev/start
```

## Local verification

```bash
cd worker
npm run typecheck
npm run test
npm run cf-typegen
npm run dev
```

`npm run cf-typegen` refreshes `worker-configuration.d.ts` from `wrangler.jsonc`;
rerun it after binding, variable, or compatibility-date changes.

With `wrangler dev` running and `.dev.vars` filled:

```bash
curl -H "Authorization: Bearer $CONTROL_TOKEN" http://localhost:8787/start
curl -H "Authorization: Bearer $CONTROL_TOKEN" http://localhost:8787/status
```

`/start` is idempotent and arms the singleton Durable Object alarm. `/status`
returns the persisted clock state plus `alarmAt`. Both control routes require
`CONTROL_TOKEN`; the default `/` route stays public and returns only a plain
health string.

## Implementation notes

- `src/telegram.ts` dynamically imports GramJS inside `connectTelegram()` so the
  Worker can start, typecheck, and run non-Telegram tests without opening or
  bundling a Telegram connection at module load time.
- `ClockDurableObject` opens the GramJS client only for the duration of a single
  alarm tick and disconnects it in a `finally` block. GramJS keepalive timers
  would otherwise keep the Durable Object pinned in memory (continuous GB-s
  billing); dropping the socket lets the DO go idle between minutes and reconnect
  next tick from the persisted StringSession. Persisted state is limited to
  `lastTargetHhmm`, `lastSetName`, `weatherText`, and `nextWeatherFetchMs`.
- Set `TELEGRAM_DRY_RUN=1` to compute and log the name (`[DRY] Would set name`)
  without opening a Telegram connection or changing the account. Opt-in only;
  any unset/`0`/`false` value performs the real rename.
- Weather failure keeps the last cached weather text and does not block clock-only
  name updates.
- FloodWait-like Telegram errors re-arm the alarm for the reported wait plus one
  second; generic errors retry after a short alarm.

## Manual production checks

1. Run `npm run login` locally and put the printed GramJS session into
   `TG_STRING_SESSION`.
2. Fill `.dev.vars` or production secrets. Do not reuse the Python/Telethon
   session string.
3. Start local dev, call authenticated `/start`, then check authenticated
   `/status` for a non-null `alarmAt`.
4. Watch logs across a minute boundary and confirm `[TRY]` and `[CONFIRM]`.
5. If QWeather is configured, verify QWeather succeeds or Open-Meteo fallback
   logs a warning and still updates weather text.

## Troubleshooting

- `/status` has `alarmAt: null`: call `/start`; if it remains null, inspect logs
  for config validation errors.
- `/start` or `/status` returns 401/503: set `CONTROL_TOKEN` in `.dev.vars` or
  with `wrangler secret put CONTROL_TOKEN`, then send it as a Bearer token.
- `TG_STRING_SESSION` errors: regenerate with `npm run login`; Telethon sessions
  are not compatible with GramJS.
- QWeather `401` or private-key errors: check `QW_HOST`, `QW_PROJECT_ID`,
  `QW_KEY_ID`/`QW_JWT_KID`, and whether `QW_PRIVATE_KEY`/`QW_JWT_PRIVATE_KEY`
  is PEM or base64 DER PKCS#8.
- Repeated `[FLOOD]`: wait for the reported backoff and avoid more frequent
  profile updates.
- No weather with Open-Meteo fallback: either set `OPEN_METEO_LATITUDE` and
  `OPEN_METEO_LONGITUDE`, or make `QW_LOCATION` a `lon,lat` pair.
