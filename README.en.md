# Telegram Name Clock Weather

[中文文档](README.md)

Turn your Telegram first name into a live clock + weather display. Every contact who sees your name in their chat list or contacts gets a glance at your **current local time and weather**.

```
Alice 𝟏𝟑:𝟓𝟏 ☀️𝟐𝟎°𝐂
```

## ⚠️ Read before you run

- `TG_STRING_SESSION` is **equivalent to a full Telegram login credential**. Anyone who has it can sign into your account, read every chat, and impersonate you. Keep it in `.env`, never commit it, never share it.
- Every Telegram contact will continuously see your timezone and weather, which **indirectly leaks your approximate location**.
- Telegram rate-limits profile changes. The default once-per-minute update is usually safe; aggressive settings can trigger `FloodWait` and lock you out for hours or days.

## How it works

Every minute boundary, the script:

1. Calls the Telegram API with `TG_STRING_SESSION` to set its own `first_name` to `{BASE_NAME} {time} {emoji}{temp}°C`.
2. Renders time and temperature using the Unicode style you chose (𝟏𝟑:𝟓𝟏, 𝟐𝟎°𝐂, etc.).
3. Refreshes weather every 30 min (default):
   - If QWeather auth is configured → use QWeather.
   - Otherwise / on failure → fall back to the free, no-registration [Open-Meteo](https://open-meteo.com/).

## You will need

- A machine that runs Docker (local box, VPS, anything).
- Telegram `API_ID` and `API_HASH` — request them at [my.telegram.org](https://my.telegram.org) → API development tools.
- A `TG_STRING_SESSION` generated once locally (see [Generate `TG_STRING_SESSION`](#generate-tg_string_session)).
- Coordinates — QWeather uses `lon,lat`; Open-Meteo takes separate `lat` / `lon`.
- Optional: a [QWeather](https://dev.qweather.com/) account and dedicated API host.

## Quick start (one-shot script)

The lazy path — fully interactive, asks for whatever it needs:

```bash
git clone https://github.com/clavulin/telegram-name-clock-weather.git
cd telegram-name-clock-weather
./install.sh
```

What the script does: checks Docker → asks for `API_ID`/`API_HASH` → spins up a throwaway container to generate `TG_STRING_SESSION` interactively (it prompts you for phone + verification code) → asks for display name, timezone, coordinates → defaults to free Open-Meteo (QWeather is opt-in) → writes `.env` → `docker compose up -d` → tails the last few log lines to confirm.

All you need: a Docker host and a pair of Telegram `API_ID`/`API_HASH` from [my.telegram.org](https://my.telegram.org) → API development tools.

## Manual start (full control)

```bash
# 1. Clone
git clone https://github.com/clavulin/telegram-name-clock-weather.git
cd telegram-name-clock-weather

# 2. Configure
cp .env.example .env
# Fill in TG_API_ID / TG_API_HASH / TG_STRING_SESSION / BASE_NAME (all required)
# Plus coordinates: QW_LOCATION or OPEN_METEO_LATITUDE + OPEN_METEO_LONGITUDE

# 3. Start (uses prebuilt GHCR image)
docker compose pull
docker compose up -d

# 4. Tail logs
docker compose logs -f
```

A healthy startup looks like:

```
[INIT] Current Telegram first_name -> Alice
[WEATHER] Updated -> ☀️𝟐𝟎°𝐂
[TRY] Setting name -> Alice 𝟏𝟑:𝟓𝟏 ☀️𝟐𝟎°𝐂
[CONFIRM] Telegram now shows -> Alice 𝟏𝟑:𝟓𝟏 ☀️𝟐𝟎°𝐂
```

## Build from source (optional)

```bash
docker build -t telegram-name-clock-weather:local .
docker run -d \
  --name telegram-name-clock-weather \
  --restart unless-stopped \
  --env-file .env \
  telegram-name-clock-weather:local

docker logs -f telegram-name-clock-weather
```

## Generate `TG_STRING_SESSION`

**Run this locally**, not on the server — the step needs interactive input (phone + code).

```bash
pip install telethon
```

```python
from telethon.sync import TelegramClient
from telethon.sessions import StringSession

api_id = 123456            # your API_ID
api_hash = "your_api_hash" # your API_HASH

with TelegramClient(StringSession(), api_id, api_hash) as client:
    print("TG_STRING_SESSION=" + client.session.save())
```

It will prompt for:

1. Phone number with country code (e.g. `+15555555555`).
2. Verification code Telegram sends you.
3. 2FA password, if you have it enabled.

The long string it prints at the end is your `TG_STRING_SESSION`. Copy it into `.env`.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `TG_API_ID` | ✅ | — | API ID from my.telegram.org |
| `TG_API_HASH` | ✅ | — | API hash from my.telegram.org |
| `TG_STRING_SESSION` | ✅ | — | Telethon string session (see above) |
| `BASE_NAME` | ✅ | — | Fixed prefix before the dynamic part, e.g. `Alice` |
| `TZ_NAME` | | `Australia/Sydney` | IANA timezone. Use `Asia/Shanghai`, **not** `China/Shanghai` |
| `TIME_FORMAT` | | `{time}` | Time template; `{time}` is replaced with `HH:MM` |
| `TIME_STYLE` | | `fancy` | Unicode style for time, see [Style preview](#style-preview) |
| `TEMP_STYLE` | | `fancy` | Unicode style for temperature |
| `AHEAD_SECONDS` | | `0` | Switch to next minute this many seconds early (compensate for network latency) |
| `GUARD_SECONDS` | | `0.15` | Scheduling guard buffer in seconds |
| `WEATHER_ENABLED` | | `1` | Set `0` to disable weather and show time only |
| `WEATHER_REFRESH_SECONDS` | | `1800` | Weather refresh interval, hard floor 60s |

### Weather sources

**QWeather** (your own account, more accurate):

| Variable | Required | Description |
|---|---|---|
| `QW_HOST` | ✅ | Dedicated API host from the QWeather console, **without `https://`** |
| `QW_LOCATION` | ✅ | `lon,lat` (note the order!) or a QWeather LocationID |
| `QW_LANG` | | Default `zh` |
| `QW_UNIT` | | Default `m` (metric) |

QWeather auth — **pick one**:

| Path | Variables |
|---|---|
| A. Dynamic JWT (recommended) | `QW_PROJECT_ID` + `QW_KEY_ID` + `QW_PRIVATE_KEY` (PEM text or base64 DER) + optional `QW_JWT_TTL_SECONDS` (default `900`) |
| B. Static JWT | `QW_JWT` |
| C. API key | `QW_API_KEY` |

**Open-Meteo** (free, no signup; used as fallback or on its own):

| Variable | Description |
|---|---|
| `OPEN_METEO_LATITUDE` | Latitude (−90 ~ 90) |
| `OPEN_METEO_LONGITUDE` | Longitude (−180 ~ 180) |

> If `QW_LOCATION` is already `lon,lat`, you can omit these — it's reused automatically. A QWeather LocationID can't be converted to coordinates.

## Style preview

Sample: `Alice 13:51 ☀️20°C`

```text
normal            | Alice 13:51 ☀️20°C
bold              | Alice 𝟏𝟑:𝟓𝟏 ☀️𝟐𝟎°𝐂      ← fancy is an alias of bold
italic            | Alice 13:51 ☀️20°𝐶
bold_italic       | Alice 13:51 ☀️20°𝑪
script            | Alice 13:51 ☀️20°𝒞
bold_script       | Alice 13:51 ☀️20°𝓒
fraktur           | Alice 13:51 ☀️20°ℭ
bold_fraktur      | Alice 13:51 ☀️20°𝕮
double_struck     | Alice 𝟙𝟛:𝟝𝟙 ☀️𝟚𝟘°ℂ
sans              | Alice 𝟣𝟥:𝟧𝟣 ☀️𝟤𝟢°𝖢
sans_italic       | Alice 13:51 ☀️20°𝘊
sans_bold         | Alice 𝟭𝟯:𝟱𝟭 ☀️𝟮𝟬°𝗖
sans_bold_italic  | Alice 13:51 ☀️20°𝘾
monospace         | Alice 𝟷𝟹:𝟻𝟷 ☀️𝟸𝟶°𝙲
```

Notes:
- Some Unicode math styles only provide letters, not digits. Those styles keep digits plain and only restyle the `C`.
- Hyphen / space variants are accepted: `sans-serif-bold` and `sans serif bold` both map to `sans_bold`.

## Troubleshooting

**`expected lon,lat`**
QWeather isn't configured, `OPEN_METEO_LATITUDE/LONGITUDE` are missing, and `QW_LOCATION` is a LocationID. Set `QW_LOCATION=lon,lat` or configure Open-Meteo coordinates separately.

**QWeather `401 Unauthorized`**
Check `QW_HOST` (must be the dedicated host from your console, not `devapi.qweather.com`), project/key IDs, `QW_PRIVATE_KEY`, and JWT TTL.

**Telegram `FloodWaitError`**
You hit the profile-update rate limit. Wait out the seconds printed in the log, then restart, and don't dial refresh settings down too aggressively.

**Name gets truncated**
Telegram caps `first_name` at 64 characters. Long `BASE_NAME` or character-hungry styles can hit that limit — shorten the name or switch to a leaner style.

**Name not updating**
Check `docker compose logs -f`:
- No `[TRY]` lines → the scheduler is stuck, look for repeated `[ERR]`.
- `[TRY]` but no `[CONFIRM]` → Telegram rejected it, usually expired session. Regenerate `TG_STRING_SESSION`.

## License

[MIT](LICENSE)
