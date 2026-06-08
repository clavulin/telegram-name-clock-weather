import os
import time
import base64
import json
import string
import unicodedata
from datetime import datetime, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

import requests
from telethon.sync import TelegramClient
from telethon.sessions import StringSession
from telethon.tl.functions.account import UpdateProfileRequest
from telethon.errors import FloodWaitError
from cryptography.hazmat.primitives import serialization


# --- Time helpers ---
def tz_now(tz_name: str) -> datetime:
    return datetime.now(ZoneInfo(tz_name))


def compute_target_hhmm(now_real: datetime, ahead_seconds: float) -> str:
    target_time = now_real + timedelta(seconds=ahead_seconds)
    return target_time.strftime("%H:%M")


def next_fire_time(now_real: datetime, ahead_seconds: float) -> datetime:
    target_time = now_real + timedelta(seconds=ahead_seconds)
    next_boundary = target_time.replace(second=0, microsecond=0) + timedelta(minutes=1)
    return next_boundary - timedelta(seconds=ahead_seconds)


def smart_sleep(seconds: float):
    if seconds > 0:
        time.sleep(seconds)

# --- Unicode style helpers ---
_UNICODE_DIGIT_NAMES = (
    "ZERO",
    "ONE",
    "TWO",
    "THREE",
    "FOUR",
    "FIVE",
    "SIX",
    "SEVEN",
    "EIGHT",
    "NINE",
)

_UNICODE_STYLE_NAMES = {
    "bold": "BOLD",
    "bold_italic": "BOLD ITALIC",
    "bold_fraktur": "BOLD FRAKTUR",
    "bold_script": "BOLD SCRIPT",
    "double_struck": "DOUBLE-STRUCK",
    "fraktur": "FRAKTUR",
    "italic": "ITALIC",
    "monospace": "MONOSPACE",
    "sans": "SANS-SERIF",
    "sans_bold": "SANS-SERIF BOLD",
    "sans_bold_italic": "SANS-SERIF BOLD ITALIC",
    "sans_italic": "SANS-SERIF ITALIC",
    "script": "SCRIPT",
}

_UNICODE_STYLE_ALIASES = {
    "bold": "bold",
    "fancy": "bold",
    "bold_italic": "bold_italic",
    "bold_fraktur": "bold_fraktur",
    "bold_script": "bold_script",
    "double_struck": "double_struck",
    "double-struck": "double_struck",
    "double struck": "double_struck",
    "fraktur": "fraktur",
    "italic": "italic",
    "mono": "monospace",
    "monospace": "monospace",
    "normal": "normal",
    "plain": "normal",
    "sans": "sans",
    "sans_bold": "sans_bold",
    "sans-bold": "sans_bold",
    "sans_serif": "sans",
    "sans-serif": "sans",
    "sans serif": "sans",
    "sans_serif_bold": "sans_bold",
    "sans-serif-bold": "sans_bold",
    "sans serif bold": "sans_bold",
    "sans_bold_italic": "sans_bold_italic",
    "sans-bold-italic": "sans_bold_italic",
    "sans_serif_bold_italic": "sans_bold_italic",
    "sans-serif-bold-italic": "sans_bold_italic",
    "sans serif bold italic": "sans_bold_italic",
    "sans_italic": "sans_italic",
    "sans-italic": "sans_italic",
    "sans_serif_italic": "sans_italic",
    "sans-serif-italic": "sans_italic",
    "sans serif italic": "sans_italic",
    "script": "script",
}

_UNICODE_STYLE_LETTER_ALIASES = {
    "double_struck": {
        "C": "ℂ",
        "H": "ℍ",
        "N": "ℕ",
        "P": "ℙ",
        "Q": "ℚ",
        "R": "ℝ",
        "Z": "ℤ",
    },
    "fraktur": {
        "C": "ℭ",
        "H": "ℌ",
        "I": "ℑ",
        "R": "ℜ",
        "Z": "ℨ",
    },
    "script": {
        "B": "ℬ",
        "E": "ℰ",
        "F": "ℱ",
        "H": "ℋ",
        "I": "ℐ",
        "L": "ℒ",
        "M": "ℳ",
        "R": "ℛ",
    },
}


def _lookup_unicode_glyph(*names: str) -> Optional[str]:
    for name in names:
        try:
            return unicodedata.lookup(name)
        except KeyError:
            continue
    return None


def normalize_unicode_style(value: str, env_name: str) -> str:
    style = (value or "fancy").strip().lower().replace("-", "_").replace(" ", "_")
    style = _UNICODE_STYLE_ALIASES.get(style, style)
    if style == "normal" or style in _UNICODE_STYLE_NAMES:
        return style
    print(f"[WARN] Invalid {env_name}={value!r}; using bold")
    return "bold"


def _style_char(style: str, ch: str) -> Optional[str]:
    if style == "normal" or len(ch) != 1 or not ch.isascii():
        return None

    style_name = _UNICODE_STYLE_NAMES[style]
    if ch.isdigit():
        digit_name = _UNICODE_DIGIT_NAMES[ord(ch) - ord("0")]
        return _lookup_unicode_glyph(
            f"MATHEMATICAL {style_name} DIGIT {digit_name}",
            f"{style_name} DIGIT {digit_name}",
        )

    if ch.isalpha():
        case = "CAPITAL" if ch.isupper() else "SMALL"
        base = ch.upper()
        glyph = _lookup_unicode_glyph(
            f"MATHEMATICAL {style_name} {case} {base}",
            f"{style_name} {case} {base}",
        )
        if glyph is not None:
            return glyph
        if ch.isupper():
            return _UNICODE_STYLE_LETTER_ALIASES.get(style, {}).get(base)

    return None


def format_unicode_style(text: str, style: str, include_letters: bool = False) -> str:
    if style == "normal":
        return text

    translation = {}
    charset = string.digits + (string.ascii_letters if include_letters else "")
    for ch in charset:
        glyph = _style_char(style, ch)
        if glyph is not None:
            translation[ord(ch)] = glyph
    return text.translate(translation)

# --- Telegram name helpers ---
def clamp_name(s: str, max_len: int = 64) -> str:
    return s[:max_len]


# --- Weather helpers (QWeather / Open-Meteo) ---
def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def build_qweather_jwt() -> str:
    kid = os.environ["QW_KEY_ID"].strip()
    sub = os.environ["QW_PROJECT_ID"].strip()
    private_key_text = os.environ["QW_PRIVATE_KEY"].strip()
    ttl_seconds = int(os.environ.get("QW_JWT_TTL_SECONDS", "900"))

    if private_key_text.startswith("-----BEGIN"):
        private_key = serialization.load_pem_private_key(private_key_text.encode("utf-8"), password=None)
    else:
        private_key_der = base64.b64decode(private_key_text)
        private_key = serialization.load_der_private_key(private_key_der, password=None)

    iat = int(time.time()) - 30
    exp = iat + ttl_seconds

    header = _b64url(json.dumps({"alg": "EdDSA", "kid": kid}, separators=(",", ":")).encode("utf-8"))
    payload = _b64url(json.dumps({"sub": sub, "iat": iat, "exp": exp}, separators=(",", ":")).encode("utf-8"))
    signing_input = f"{header}.{payload}".encode("ascii")
    signature = _b64url(private_key.sign(signing_input))
    return f"{header}.{payload}.{signature}"


def qweather_emoji(icon_code: str) -> str:
    """
    Coarse-grained emoji mapping for QWeather icon codes.
    Example icon codes: day sunny 100, night sunny 150.
    """
    try:
        code = int(icon_code)
    except Exception:
        return "☁️"

    # Sunny (day/night)
    if code == 100:
        return "☀️"
    if code == 150:
        return "🌙"

    # Partly cloudy / few clouds (day 102-103, night 152-153) — check first so the
    # broader cloudy range below does not swallow them.
    if code in (102, 103, 152, 153):
        return "🌤️"
    # Cloudy/overcast (101-104; night variants 151-154)
    if 101 <= code <= 104 or 151 <= code <= 154:
        return "☁️"

    # Fog/haze/dust (500+)
    if 500 <= code <= 515:
        return "🌫️"

    # Rain (300-399)
    if 300 <= code <= 399:
        # Thunderstorm codes are commonly 302/303.
        if code in (302, 303):
            return "⛈️"
        return "🌧️"

    # Snow/sleet (400-499)
    if 400 <= code <= 499:
        return "🌨️"

    return "☁️"


def open_meteo_emoji(weather_code: int, is_day: Optional[int] = None) -> str:
    """
    Emoji mapping for Open-Meteo WMO weather codes.
    """
    if weather_code == 0:
        return "☀️" if is_day else "🌙"

    if weather_code in (1, 2):
        return "🌤️" if is_day else "☁️"
    if weather_code == 3:
        return "☁️"

    if weather_code in (45, 48):
        return "🌫️"

    if weather_code in (51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82):
        return "🌧️"

    if weather_code in (71, 73, 75, 77, 85, 86):
        return "🌨️"

    if weather_code in (95, 96, 99):
        return "⛈️"

    return "☁️"


def qweather_auth_configured() -> bool:
    return bool(_env("QW_API_KEY") or _env("QW_JWT") or qweather_dynamic_auth_configured())


def qweather_dynamic_auth_configured() -> bool:
    return bool(
        _env("QW_PROJECT_ID")
        and _env("QW_KEY_ID")
        and _env("QW_PRIVATE_KEY")
    )


def parse_lon_lat(value: str) -> tuple[float, float]:
    parts = [part.strip() for part in value.split(",")]
    if len(parts) != 2:
        raise ValueError("expected lon,lat")

    lon = float(parts[0])
    lat = float(parts[1])

    if not -180 <= lon <= 180 or not -90 <= lat <= 90:
        raise ValueError("longitude/latitude out of range")

    return lon, lat


def fetch_weather_qweather(timeout: float = 6.0) -> tuple[str, int]:
    """
    Returns: (emoji, temp_c_int)

    Endpoint: /v7/weather/now
    Auth: JWT (Authorization: Bearer ...) or API key (X-QW-Api-Key).
    """
    host = os.environ["QW_HOST"].strip()          # Dedicated API host (without https://)
    location = os.environ["QW_LOCATION"].strip()  # lon,lat or LocationID

    jwt_token = build_qweather_jwt() if qweather_dynamic_auth_configured() else os.environ.get("QW_JWT", "").strip()
    api_key = os.environ.get("QW_API_KEY", "").strip()
    if not jwt_token and not api_key:
        raise RuntimeError("Need dynamic JWT envs (QW_PROJECT_ID/QW_KEY_ID/QW_PRIVATE_KEY), or QW_JWT, or QW_API_KEY")

    url = f"https://{host}/v7/weather/now"
    params = {
        "location": location,
        "lang": os.environ.get("QW_LANG", "zh").strip(),
        "unit": os.environ.get("QW_UNIT", "m").strip(),  # m=metric
    }

    headers = {}
    if jwt_token:
        headers["Authorization"] = f"Bearer {jwt_token}"
    else:
        # API key mode (header-based; params['key'] also works)
        headers["X-QW-Api-Key"] = api_key

    r = requests.get(url, params=params, headers=headers, timeout=timeout)
    r.raise_for_status()
    data = r.json()

    if data.get("code") != "200":
        raise RuntimeError(f"QWeather error code={data.get('code')}")

    now = data.get("now") or {}
    temp = now.get("temp")
    icon = now.get("icon")
    if temp is None or icon is None:
        raise RuntimeError("QWeather response missing now.temp/now.icon")

    emoji = qweather_emoji(str(icon))
    return emoji, int(round(float(temp)))


def open_meteo_coordinates() -> tuple[float, float]:
    lat_text = _env("OPEN_METEO_LATITUDE")
    lon_text = _env("OPEN_METEO_LONGITUDE")
    if bool(lat_text) != bool(lon_text):
        raise ValueError("OPEN_METEO_LATITUDE and OPEN_METEO_LONGITUDE must be set together")

    if lat_text and lon_text:
        lat = float(lat_text)
        lon = float(lon_text)
    else:
        lon, lat = parse_lon_lat(_env("QW_LOCATION"))

    if not -90 <= lat <= 90 or not -180 <= lon <= 180:
        raise ValueError("Open-Meteo latitude/longitude out of range")

    return lat, lon


def fetch_weather_open_meteo(timeout: float = 6.0) -> tuple[str, int]:
    """
    Returns: (emoji, temp_c_int)

    Open-Meteo forecast API does not require an API key for non-commercial use.
    It needs latitude/longitude, so QW_LOCATION must be lon,lat when reused here.
    """
    lat, lon = open_meteo_coordinates()
    params = {
        "latitude": lat,
        "longitude": lon,
        "current": "temperature_2m,weather_code,is_day",
        "temperature_unit": "celsius",
        "timezone": "auto",
    }

    r = requests.get("https://api.open-meteo.com/v1/forecast", params=params, timeout=timeout)
    r.raise_for_status()
    data = r.json()

    current = data.get("current") or {}
    temp = current.get("temperature_2m")
    weather_code = current.get("weather_code")
    if temp is None or weather_code is None:
        raise RuntimeError("Open-Meteo response missing current.temperature_2m/current.weather_code")

    emoji = open_meteo_emoji(int(weather_code), current.get("is_day"))
    return emoji, int(round(float(temp)))


def fetch_weather(timeout: float = 6.0) -> tuple[str, int]:
    if qweather_auth_configured():
        try:
            return fetch_weather_qweather(timeout=timeout)
        except Exception as e:
            try:
                emoji, temp_c = fetch_weather_open_meteo(timeout=timeout)
                print(f"[WEATHER_WARN] QWeather failed ({type(e).__name__}: {e}); used Open-Meteo fallback")
                return emoji, temp_c
            except Exception as fallback_e:
                raise RuntimeError(
                    f"QWeather failed ({type(e).__name__}: {e}); "
                    f"Open-Meteo fallback also failed ({type(fallback_e).__name__}: {fallback_e})"
                ) from fallback_e

    return fetch_weather_open_meteo(timeout=timeout)


def main():
    # Telegram auth
    api_id = int(os.environ["TG_API_ID"])
    api_hash = os.environ["TG_API_HASH"]
    session_str = os.environ["TG_STRING_SESSION"]

    # Name format
    base_name = os.environ.get("BASE_NAME", "").strip()
    tz_name = os.environ.get("TZ_NAME", "Asia/Shanghai").strip()
    suffix_time_fmt = os.environ.get("TIME_FORMAT", "{time}").strip()  # default "{time}"
    time_style = normalize_unicode_style(os.environ.get("TIME_STYLE", "fancy"), "TIME_STYLE")
    temp_style = normalize_unicode_style(os.environ.get("TEMP_STYLE", "fancy"), "TEMP_STYLE")

    # Scheduling
    ahead_seconds = float(os.environ.get("AHEAD_SECONDS", "0"))
    guard_seconds = float(os.environ.get("GUARD_SECONDS", "0.15"))

    # Weather config
    weather_refresh = float(os.environ.get("WEATHER_REFRESH_SECONDS", "1800"))  # Default: 30 minutes
    weather_enabled = os.environ.get("WEATHER_ENABLED", "1").strip() not in ("0", "false", "False")

    if not base_name:
        raise SystemExit("BASE_NAME is required (e.g. BASE_NAME='冰漫梦涯')")

    client = TelegramClient(StringSession(session_str), api_id, api_hash)

    last_target_hhmm = None
    last_set_name = None

    # Weather cache
    weather_text = ""  # e.g. "☁️25℃"
    next_weather_fetch_ts = 0.0

    with client:
        me = client.get_me()
        print(f"[INIT] Current Telegram first_name -> {me.first_name}")
        print(
            f"[INIT] TZ_NAME={tz_name} AHEAD_SECONDS={ahead_seconds} "
            f"TIME_STYLE={time_style} TEMP_STYLE={temp_style} WEATHER_ENABLED={weather_enabled}"
        )
        if weather_enabled:
            print(
                f"[INIT] QW_HOST={os.environ.get('QW_HOST')} "
                f"QW_LOCATION={os.environ.get('QW_LOCATION')} "
                f"OPEN_METEO_LATITUDE={os.environ.get('OPEN_METEO_LATITUDE')} "
                f"OPEN_METEO_LONGITUDE={os.environ.get('OPEN_METEO_LONGITUDE')} "
                f"WEATHER_REFRESH_SECONDS={weather_refresh}"
            )
        while True:
            try:
                # refresh weather if needed (cached)
                now_ts = time.time()
                if weather_enabled and now_ts >= next_weather_fetch_ts:
                    try:
                        emoji, temp_c = fetch_weather()
                        weather_text = f"{emoji}{format_unicode_style(f'{temp_c}°C', temp_style, include_letters=True)}"
                        print(f"[WEATHER] Updated -> {weather_text}")
                    except Exception as e:
                        # Keep previous weather so rename flow is not blocked.
                        print(f"[WEATHER_ERR] {type(e).__name__}: {e} (keeping last: '{weather_text}')")
                    next_weather_fetch_ts = now_ts + max(weather_refresh, 60.0)  # Minimum 60s to avoid rapid retries

                # time + schedule
                now_real = tz_now(tz_name)
                target_hhmm = compute_target_hhmm(now_real, ahead_seconds)

                if target_hhmm != last_target_hhmm:
                    plain_time = suffix_time_fmt.format(time=target_hhmm).strip()
                    time_part = format_unicode_style(plain_time, time_style, include_letters=True)
                    # Compose final name, e.g. "BaseName 22:15 ☁️25℃".
                    name_parts = [base_name, time_part]

                    if weather_enabled and weather_text:
                        name_parts.append(weather_text)

                    new_name = clamp_name(" ".join(name_parts))

                    if new_name != last_set_name:
                        print(f"[TRY] Setting name -> {new_name}")
                        client(UpdateProfileRequest(first_name=new_name))
                        me = client.get_me()
                        print(f"[CONFIRM] Telegram now shows -> {me.first_name}")
                        last_set_name = me.first_name

                    last_target_hhmm = target_hhmm

                fire_time = next_fire_time(now_real, ahead_seconds)
                sleep_s = (fire_time - tz_now(tz_name)).total_seconds() - guard_seconds
                smart_sleep(sleep_s)

                while tz_now(tz_name) < fire_time:
                    smart_sleep(0.005)

            except FloodWaitError as e:
                wait_s = int(getattr(e, "seconds", 60))
                print(f"[FLOOD] Need to wait {wait_s}s")
                smart_sleep(wait_s + 1)
            except Exception as e:
                print(f"[ERR] {type(e).__name__}: {e}")
                smart_sleep(5)


if __name__ == "__main__":
    main()
