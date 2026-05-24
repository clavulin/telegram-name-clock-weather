# Telegram Name Clock Weather

[English README](README.en.md)

让你的 Telegram 昵称像电子表一样，实时显示**当前时间和所在地天气**——所有联系人在聊天列表、通讯录里看到你时，都会瞥见这串信息。

```
Alice 𝟏𝟑:𝟓𝟏 ☀️𝟐𝟎°𝐂
```

## ⚠️ 跑之前必读

- `TG_STRING_SESSION` **等同于完整的 Telegram 登录凭证**。任何人拿到都能登录你的账号、读全部聊天、冒充你发消息。只放进 `.env`，不要提交 Git，不要发给任何人。
- 你的所有 Telegram 联系人都会持续看到你的时区与天气，**间接暴露你的大致位置**。
- Telegram 对修改 profile 有频率限制。默认每分钟一次通常没事，但调激进了会触发 `FloodWait`，被限流几小时到几天。

## 工作原理

每分钟边界前，脚本会：

1. 用 `TG_STRING_SESSION` 调 Telegram API，把自己的 `first_name` 改成 `{BASE_NAME} {时间} {emoji}{温度}°C`；
2. 时间和温度按你选的 Unicode 字体样式渲染（𝟏𝟑:𝟓𝟏、𝟐𝟎°𝐂 这种）；
3. 天气每 30 分钟（默认）拉一次：
   - 配了 QWeather 鉴权 → 优先 QWeather；
   - 没配 / QWeather 失败 → 自动 fallback 到免费免注册的 [Open-Meteo](https://open-meteo.com/)。

## 准备工作

- 一台能跑 Docker 的机器（本地、VPS 都行）
- Telegram `API_ID` + `API_HASH`：到 [my.telegram.org](https://my.telegram.org) → API development tools 申请
- `TG_STRING_SESSION`：本地一次性生成（[步骤](#生成-tg_string_session)）
- 坐标：QWeather 用 `经度,纬度`；Open-Meteo 用单独的 lat / lon
- 可选：[QWeather](https://dev.qweather.com/) 账号 + 专属 API host

## 快速开始（一键脚本）

懒人路径，全程交互问你要什么填什么：

```bash
git clone https://github.com/clavulin/telegram-name-clock-weather.git
cd telegram-name-clock-weather
./install.sh
```

脚本会：检查 Docker → 让你输入 API_ID/HASH → 在临时容器里交互登录生成 `TG_STRING_SESSION`（直接问你手机号和验证码）→ 让你填昵称/时区/坐标 → 默认走免费的 Open-Meteo（也可选 QWeather）→ 写 `.env` → `docker compose up -d` → 贴最后几十行日志确认。

需要的只是一个能跑 Docker 的机器，和一对 Telegram `API_ID`/`API_HASH`（[my.telegram.org](https://my.telegram.org) → API development tools）。

## 手动开始（想自己控制每一步）

```bash
# 1. 克隆
git clone https://github.com/clavulin/telegram-name-clock-weather.git
cd telegram-name-clock-weather

# 2. 配置
cp .env.example .env
# 编辑 .env：必填 TG_API_ID / TG_API_HASH / TG_STRING_SESSION / BASE_NAME
# 加坐标：QW_LOCATION 或 OPEN_METEO_LATITUDE + OPEN_METEO_LONGITUDE

# 3. 启动（用 GHCR 预构建镜像）
docker compose pull
docker compose up -d

# 4. 看日志
docker compose logs -f
```

启动正常的日志大概长这样：

```
[INIT] Current Telegram first_name -> Alice
[WEATHER] Updated -> ☀️𝟐𝟎°𝐂
[TRY] Setting name -> Alice 𝟏𝟑:𝟓𝟏 ☀️𝟐𝟎°𝐂
[CONFIRM] Telegram now shows -> Alice 𝟏𝟑:𝟓𝟏 ☀️𝟐𝟎°𝐂
```

## 源码构建（可选）

```bash
docker build -t telegram-name-clock-weather:local .
docker run -d \
  --name telegram-name-clock-weather \
  --restart unless-stopped \
  --env-file .env \
  telegram-name-clock-weather:local

docker logs -f telegram-name-clock-weather
```

## 生成 `TG_STRING_SESSION`

**在本地跑**，不要在服务器上跑——这一步需要交互输入手机号和验证码。

```bash
pip install telethon
```

```python
from telethon.sync import TelegramClient
from telethon.sessions import StringSession

api_id = 123456            # 换成你的 API_ID
api_hash = "your_api_hash" # 换成你的 API_HASH

with TelegramClient(StringSession(), api_id, api_hash) as client:
    print("TG_STRING_SESSION=" + client.session.save())
```

运行后会依次提示：

1. 手机号（带国际区号，如 `+8613800000000`）
2. Telegram 发来的验证码
3. 如果开了二次验证，还会问密码

最后输出的那一长串就是 `TG_STRING_SESSION`，整段复制到 `.env`。

## 配置项

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `TG_API_ID` | ✅ | — | my.telegram.org 拿的 API ID |
| `TG_API_HASH` | ✅ | — | my.telegram.org 拿的 API Hash |
| `TG_STRING_SESSION` | ✅ | — | Telethon 会话串（见上方） |
| `BASE_NAME` | ✅ | — | 动态部分前面的固定昵称，比如 `Alice` |
| `TZ_NAME` | | `Australia/Sydney` | IANA 时区，**中国是 `Asia/Shanghai`，不是 `China/Shanghai`** |
| `TIME_FORMAT` | | `{time}` | 时间模板，`{time}` 替换为 `HH:MM` |
| `TIME_STYLE` | | `fancy` | 时间字体样式，见[样式预览](#样式预览) |
| `TEMP_STYLE` | | `fancy` | 温度字体样式，同上 |
| `AHEAD_SECONDS` | | `0` | 提前几秒切换到下一分钟（应对网络延迟） |
| `GUARD_SECONDS` | | `0.15` | 调度安全余量（秒），一般不动 |
| `WEATHER_ENABLED` | | `1` | `0` 关闭天气，只显示时间 |
| `WEATHER_REFRESH_SECONDS` | | `1800` | 天气拉取间隔，最小强制 60s |

### 天气数据源

**QWeather**（自己有账号、精度更高）：

| 变量 | 必填 | 说明 |
|---|---|---|
| `QW_HOST` | ✅ | QWeather 控制台分配的专属 host，**不带 `https://`** |
| `QW_LOCATION` | ✅ | `经度,纬度`（顺序别反）或 QWeather LocationID |
| `QW_LANG` | | 默认 `zh` |
| `QW_UNIT` | | 默认 `m`（公制） |

QWeather 鉴权**三选一**：

| 方式 | 需要的变量 |
|---|---|
| A. 动态 JWT（推荐） | `QW_PROJECT_ID` + `QW_KEY_ID` + `QW_PRIVATE_KEY`（PEM 文本或 base64 DER）+ 可选 `QW_JWT_TTL_SECONDS`（默认 `900`） |
| B. 静态 JWT | `QW_JWT` |
| C. API Key | `QW_API_KEY` |

**Open-Meteo**（免费免注册，作为 fallback；也可以单独用）：

| 变量 | 说明 |
|---|---|
| `OPEN_METEO_LATITUDE` | 纬度（-90 ~ 90） |
| `OPEN_METEO_LONGITUDE` | 经度（-180 ~ 180） |

> 如果 `QW_LOCATION` 已经是 `经度,纬度`，可以省略上面两个，会自动复用；但 LocationID 形式不能自动转坐标。

## 样式预览

样例：`Alice 13:51 ☀️20°C`

```text
normal            | Alice 13:51 ☀️20°C
bold              | Alice 𝟏𝟑:𝟓𝟏 ☀️𝟐𝟎°𝐂      ← fancy 是 bold 的别名
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

注意：
- Unicode 数学符号系列只覆盖了一部分字母/数字。不含数字字形的样式（italic、script 等）数字会保留为普通字形，只替换 `C`。
- 也接受连字符/空格写法：`sans-serif-bold`、`sans serif bold` 等价于 `sans_bold`。

## 故障排查

**`expected lon,lat`**
没配 QWeather，又没给 `OPEN_METEO_LATITUDE/LONGITUDE`，而 `QW_LOCATION` 是 LocationID。改成 `QW_LOCATION=经度,纬度` 或单独配 Open-Meteo 坐标。

**QWeather `401 Unauthorized`**
检查 `QW_HOST`（必须是控制台分配的专属 host，不是 `devapi.qweather.com`）、项目/密钥 ID、`QW_PRIVATE_KEY`、JWT TTL。

**Telegram `FloodWaitError`**
触发了 profile 修改频率限制。等日志里提示的秒数过去再启动；以后别把刷新参数调得太激进。

**名字被截断**
Telegram first_name 上限 64 字符。`BASE_NAME` 太长或样式占字符太多就会被砍；缩短 `BASE_NAME` 或换不那么"花"的样式。

**昵称没更新**
看 `docker compose logs -f`：
- 没 `[TRY]` 行 → 调度循环卡住，看是否反复 `[ERR]`；
- 有 `[TRY]` 但没 `[CONFIRM]` → Telegram 端拒绝了，常见是 session 过期，重新生成 `TG_STRING_SESSION`。

## 许可证

[MIT](LICENSE)
