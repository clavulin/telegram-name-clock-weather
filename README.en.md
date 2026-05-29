# Telegram Name Clock Weather

[中文文档](README.md)

Turn your Telegram first name into a live clock + weather display. Every contact who sees your name in their chat list or contacts gets a glance at your **current local time and weather**.

```
Alice 𝟏𝟑:𝟓𝟏 ☀️𝟐𝟎°𝐂
```

> **What's new on this branch?** Besides the original Docker/VPS path, there's now a **Cloudflare Worker** serverless path: no machine to babysit — it runs on the Cloudflare free plan and updates your name every minute on its own. Pick whichever one you like; both are documented below.

## ⚠️ Read before you run

- `TG_STRING_SESSION` is **equivalent to a full Telegram login credential**. Anyone who has it can sign into your account, read every chat, and impersonate you. Keep it in your secrets, never commit it, never share it.
- Every Telegram contact will continuously see your timezone and weather, which **indirectly leaks your approximate location**.
- Telegram rate-limits profile changes. The default once-per-minute update is usually safe; aggressive settings can trigger `FloodWait` and lock you out for hours or days.
- Want to dry-run the whole flow without touching your real account? Set `TELEGRAM_DRY_RUN=1` — it only logs the name it *would* set (`[DRY] Would set name`), never connecting to Telegram or changing your profile.

## Pick a deployment

| | 🐳 Docker / VPS (original) | ☁️ Cloudflare Worker (new on this branch) |
|---|---|---|
| How it runs | An always-on container | Serverless — a Durable Object alarm wakes every minute |
| You need | An always-on machine (VPS / local) | A Cloudflare account |
| Cost | VPS rent or your own power bill | The Workers **free plan** is enough (tiny usage) |
| Get-started command | `./install.sh` one-shot | `npm run login` + `wrangler deploy` |
| Session format | Telethon | GramJS (**not interchangeable — generate each separately**) |
| Best for | People who already have a server and want full control | People who don't want to maintain any server |

Not sure? **Want it hands-off and serverless → Cloudflare Worker. Already have a VPS → Docker.**

## How it works

At each minute boundary, the program:

1. Calls the Telegram API with `TG_STRING_SESSION` to set its own `first_name` to `{BASE_NAME} {time} {emoji}{temp}°C`.
2. Renders time and temperature using the Unicode style you chose (𝟏𝟑:𝟓𝟏, 𝟐𝟎°𝐂, etc.).
3. Refreshes weather every 30 min (default):
   - If QWeather auth is configured → use QWeather.
   - Otherwise / on failure → fall back to the free, no-registration [Open-Meteo](https://open-meteo.com/).

> The Docker version uses a Python `while True` daemon loop. The Cloudflare version ports the same logic into a Durable Object that uses its own `alarm()` to hit the exact minute boundary — that's why it doesn't use a plain cron, which can only fire near `:00` and can't do sub-minute alignment.

## Common prerequisites

You'll need these no matter which path you pick:

- Telegram `API_ID` and `API_HASH` — request them at [my.telegram.org](https://my.telegram.org) → API development tools.
- Coordinates — QWeather uses `lon,lat`; Open-Meteo takes separate `lat` / `lon`.
- A fixed display name `BASE_NAME` (the live time + weather is appended after it, e.g. `Alice`).
- Optional: a [QWeather](https://dev.qweather.com/) account and dedicated API host (skip it and it auto-uses Open-Meteo).

---

## Path A: Cloudflare Worker (serverless, recommended if you want it hands-off)

### You'll also need

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free plan is fine).
- Node.js 18+ on your machine.

### Steps

```bash
# 1. Clone and enter the worker directory
git clone https://github.com/clavulin/telegram-name-clock-weather.git
cd telegram-name-clock-weather/worker
npm install

# 2. Generate the GramJS session string (interactive: phone + code)
npm run login
#    Copy the long string it prints — you'll need it in the next step

# 3. Log in to Cloudflare (needed for the first deploy)
npx wrangler login        # or set the CLOUDFLARE_API_TOKEN env var

# 4. Set secrets (production — run one by one, paste each value when prompted)
npx wrangler secret put TG_API_ID
npx wrangler secret put TG_API_HASH
npx wrangler secret put TG_STRING_SESSION    # the string from step 2
npx wrangler secret put CONTROL_TOKEN        # any long random string; protects the control routes
#    Add the QW_* set too if you use QWeather (see "Configuration")

# 5. Tune the non-secret knobs: edit "vars" in worker/wrangler.jsonc
#    Change BASE_NAME from the default "Alice" to your name;
#    also adjust timezone TZ_NAME, styles TIME_STYLE/TEMP_STYLE, Open-Meteo coords, etc.

# 6. Deploy
npm run deploy
#    Deploy prints your Worker URL, like https://<your-worker>.workers.dev

# 7. Arm the alarm loop (idempotent — safe to call repeatedly)
curl -H "Authorization: Bearer $CONTROL_TOKEN" https://<your-worker>.workers.dev/start

# 8. Check status anytime (last set name, weather, next wake time)
curl -H "Authorization: Bearer $CONTROL_TOKEN" https://<your-worker>.workers.dev/status
```

> `BASE_NAME` isn't a secret — it's already in the `vars` block of `worker/wrangler.jsonc` (defaults to `Alice`); just change the value, no `secret put` needed.

### HTTP endpoints

| Path | What it does | Auth |
|---|---|---|
| `/` | Health check, returns a one-line plain string | Public |
| `/start` | Arms / re-arms the alarm loop (idempotent) | `Authorization: Bearer <CONTROL_TOKEN>` |
| `/status` | Returns current state: `lastSetName`, `weatherText`, `alarmAt`, etc. | `Authorization: Bearer <CONTROL_TOKEN>` |

### Local development (optional)

```bash
cd worker
cp .dev.vars.example .dev.vars   # fill in the secrets (BASE_NAME comes from wrangler.jsonc, not here)
npm run dev                      # run the Worker locally
# In another terminal:
curl -H "Authorization: Bearer $CONTROL_TOKEN" http://localhost:8787/start
curl -H "Authorization: Bearer $CONTROL_TOKEN" http://localhost:8787/status

npm run typecheck && npm run test   # typecheck + unit tests
```

> On cost & connections: the Worker is **not** pinned 24/7 — it wakes once per minute, drops the MTProto connection after each rename, and reconnects next tick from the persisted session string. That avoids continuous billing and stays comfortably within the Cloudflare free plan. More implementation detail in [`worker/README.md`](worker/README.md).

---

## Path B: Docker / VPS (original, if you already have a server)

### One-shot script (easiest)

The lazy path — fully interactive, asks for whatever it needs:

```bash
git clone https://github.com/clavulin/telegram-name-clock-weather.git
cd telegram-name-clock-weather
./install.sh
```

What the script does: checks Docker → asks for `API_ID`/`API_HASH` → spins up a throwaway container to generate `TG_STRING_SESSION` interactively (it prompts you for phone + verification code) → asks for display name, timezone, coordinates → defaults to free Open-Meteo (QWeather is opt-in) → writes `.env` → `docker compose up -d` → tails the last few log lines to confirm.

### Manual start (full control)

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

### Build from source (optional)

```bash
docker build -t telegram-name-clock-weather:local .
docker run -d \
  --name telegram-name-clock-weather \
  --restart unless-stopped \
  --env-file .env \
  telegram-name-clock-weather:local

docker logs -f telegram-name-clock-weather
```

---

## Generate the `TG_STRING_SESSION`

> ⚠️ **The two deployment paths use incompatible session formats!** Cloudflare Worker uses GramJS, Docker/Python uses Telethon — they can't be reused across paths. Switching paths means regenerating it.
>
> Either way, **run this locally**, not on the server — the step needs interactive input (phone + code).

### A. For Cloudflare Worker (GramJS)

```bash
cd worker
npm install
npm run login
```

Enter `api_id` / `api_hash` (reused from the environment if present), phone number, verification code, and 2FA password (leave blank if none). The string it prints at the end is your Worker `TG_STRING_SESSION`.

### B. For Docker / Python (Telethon)

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

These are shared by both paths: with Docker put them in `.env`; with Cloudflare put them in the `vars` block of `wrangler.jsonc` (use `wrangler secret put` for the secret ones).

| Variable | Required | Default | Description |
|---|---|---|---|
| `TG_API_ID` | ✅ | — | API ID from my.telegram.org |
| `TG_API_HASH` | ✅ | — | API hash from my.telegram.org |
| `TG_STRING_SESSION` | ✅ | — | Session string (GramJS for Worker, Telethon for Docker — see above) |
| `BASE_NAME` | ✅ | — | Fixed prefix before the dynamic part, e.g. `Alice` |
| `CONTROL_TOKEN` | Worker only | — | Bearer token protecting `/start` and `/status` (Cloudflare path only) |
| `TZ_NAME` | | `Australia/Sydney` | IANA timezone. Use `Asia/Shanghai`, **not** `China/Shanghai` |
| `TIME_FORMAT` | | `{time}` | Time template; `{time}` is replaced with `HH:MM` |
| `TIME_STYLE` | | `fancy` | Unicode style for time, see [Style preview](#style-preview) |
| `TEMP_STYLE` | | `fancy` | Unicode style for temperature |
| `AHEAD_SECONDS` | | `0` | Switch to next minute this many seconds early (compensate for network latency) |
| `GUARD_SECONDS` | | `0.15` | Scheduling guard buffer in seconds |
| `WEATHER_ENABLED` | | `1` | Set `0` to disable weather and show time only |
| `WEATHER_REFRESH_SECONDS` | | `1800` | Weather refresh interval, hard floor 60s |
| `TELEGRAM_DRY_RUN` | | `0` | Set `1` to only log, never touch the profile or connect to Telegram (dry run) |

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

**Telegram `FloodWaitError` / repeated `[FLOOD]` in logs**
You hit the profile-update rate limit. Wait out the seconds printed in the log (the Worker re-arms its alarm for that automatically), then don't dial refresh settings down too aggressively.

**`TG_STRING_SESSION` errors**
Usually the wrong format. The Cloudflare Worker requires the GramJS string from `npm run login`; a Telethon string won't work — regenerate it.

**Name gets truncated**
Telegram caps `first_name` at 64 characters. Long `BASE_NAME` or character-hungry styles can hit that limit — shorten the name or switch to a leaner style.

**Name not updating (Docker)**
Check `docker compose logs -f`:
- No `[TRY]` lines → the scheduler is stuck, look for repeated `[ERR]`.
- `[TRY]` but no `[CONFIRM]` → Telegram rejected it, usually expired session. Regenerate `TG_STRING_SESSION`.

**Name not updating (Cloudflare)**
- `/status` shows `alarmAt: null` → call `/start`; if it stays null, check the logs for config validation errors.
- `/start` or `/status` returns 401/503 → `CONTROL_TOKEN` is unset or not sent as a Bearer token.

See [`worker/README.md`](worker/README.md) for deeper Worker operations notes.

## License

[MIT](LICENSE)
