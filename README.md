# Telegram Name Clock Weather

[English README](README.en.md)

让你的 Telegram 昵称像电子表一样，实时显示**当前时间和所在地天气**——所有联系人在聊天列表、通讯录里看到你时，都会瞥见这串信息。

```
Alice 𝟏𝟑:𝟓𝟏 ☀️𝟐𝟎°𝐂
```

> **这个分支有什么不一样？** 在原来的 Docker/VPS 跑法之外，新增了一套 **Cloudflare Worker** 无服务器跑法：不用自己维护机器，挂在 Cloudflare 免费套餐上每分钟自动更新昵称。两种方式二选一即可，下面都有完整步骤。

## ⚠️ 跑之前必读

- `TG_STRING_SESSION` **等同于完整的 Telegram 登录凭证**。任何人拿到都能登录你的账号、读全部聊天、冒充你发消息。只放进密钥里，不要提交 Git，不要发给任何人。
- 你的所有 Telegram 联系人都会持续看到你的时区与天气，**间接暴露你的大致位置**。
- Telegram 对修改 profile 有频率限制。默认每分钟一次通常没事，但调激进了会触发 `FloodWait`，被限流几小时到几天。
- 想先验证一遍流程又不动真账号？设 `TELEGRAM_DRY_RUN=1`，它只会把"将要设置的昵称"打到日志里（`[DRY] Would set name`），不连 Telegram、不改资料。

## 选哪种部署方式？

| | 🐳 Docker / VPS（原版） | ☁️ Cloudflare Worker（本分支新增） |
|---|---|---|
| 运行方式 | 一直常驻的容器 | 无服务器，靠 Durable Object 闹钟每分钟唤醒 |
| 需要准备 | 一台常开的机器（VPS / 本地） | 一个 Cloudflare 账号 |
| 费用 | VPS 月租或自己的电费 | Workers **免费套餐**够用（用量极小） |
| 上手命令 | `./install.sh` 一键 | `npm run login` + `wrangler deploy` |
| 会话串格式 | Telethon | GramJS（**两者不通用，需各自生成**） |
| 适合 | 已经有服务器、想完全掌控的人 | 不想维护任何服务器的人 |

不知道选哪个 → **想省事、不想管机器就用 Cloudflare Worker；已经有 VPS 就用 Docker。**

## 工作原理

每到分钟边界，程序会：

1. 用 `TG_STRING_SESSION` 调 Telegram API，把自己的 `first_name` 改成 `{BASE_NAME} {时间} {emoji}{温度}°C`；
2. 时间和温度按你选的 Unicode 字体样式渲染（𝟏𝟑:𝟓𝟏、𝟐𝟎°𝐂 这种）；
3. 天气每 30 分钟（默认）拉一次：
   - 配了 QWeather 鉴权 → 优先 QWeather；
   - 没配 / QWeather 失败 → 自动 fallback 到免费免注册的 [Open-Meteo](https://open-meteo.com/)。

> Docker 版用 Python 的 `while True` 常驻循环；Cloudflare 版把同一套逻辑搬到了一个 Durable Object 里，用它自己的 `alarm()` 精确卡在分钟边界（这也是没用普通 cron 的原因——cron 只能卡在 `:00` 附近，做不到亚分钟级对齐）。

## 通用准备

不管哪种方式都要先备齐这些：

- Telegram `API_ID` + `API_HASH`：到 [my.telegram.org](https://my.telegram.org) → API development tools 申请。
- 坐标：QWeather 用 `经度,纬度`；Open-Meteo 用单独的 lat / lon。
- 一个固定昵称 `BASE_NAME`（动态时间天气会拼在它后面，比如 `Alice`）。
- 可选：[QWeather](https://dev.qweather.com/) 账号 + 专属 API host（不配也能跑，自动用 Open-Meteo）。

---

## 方式 A：Cloudflare Worker（无服务器，推荐想省事的人）

### 你还需要

- 一个 [Cloudflare 账号](https://dash.cloudflare.com/sign-up)（免费套餐即可）。
- 本机装好 Node.js 18+。

### 步骤

```bash
# 1. 克隆并进入 worker 目录
git clone https://github.com/clavulin/telegram-name-clock-weather.git
cd telegram-name-clock-weather/worker
npm install

# 2. 生成 GramJS 会话串（交互输入手机号 + 验证码）
npm run login
#    把打印出来的那一长串复制好，下一步用

# 3. 登录 Cloudflare（首次部署需要）
npx wrangler login        # 或者设置环境变量 CLOUDFLARE_API_TOKEN

# 4. 设置密钥（生产环境，逐条执行，按提示粘贴值）
npx wrangler secret put TG_API_ID
npx wrangler secret put TG_API_HASH
npx wrangler secret put TG_STRING_SESSION    # 第 2 步生成的那串
npx wrangler secret put CONTROL_TOKEN        # 自己随便设一个长随机串，用于保护控制接口
#    用 QWeather 的话再加 QW_* 一组（见“配置项”）

# 5. 调非密钥项：编辑 worker/wrangler.jsonc 里的 "vars"
#    把 BASE_NAME 从默认的 "Alice" 改成你的昵称；
#    顺便按需调时区 TZ_NAME、样式 TIME_STYLE/TEMP_STYLE、Open-Meteo 坐标等

# 6. 部署
npm run deploy
#    部署完会打印出你的 Worker 地址，形如 https://<your-worker>.workers.dev

# 7. 启动闹钟循环（幂等，可重复调）
curl -H "Authorization: Bearer $CONTROL_TOKEN" https://<your-worker>.workers.dev/start

# 8. 随时查看状态（最后设的名字、天气、下次唤醒时间）
curl -H "Authorization: Bearer $CONTROL_TOKEN" https://<your-worker>.workers.dev/status
```

> `BASE_NAME` 不是机密，已经放在 `worker/wrangler.jsonc` 的 `vars` 里（默认 `Alice`），直接改值即可，不用 `secret put`。

### HTTP 接口

| 路径 | 作用 | 鉴权 |
|---|---|---|
| `/` | 健康检查，返回一行纯文本 | 公开 |
| `/start` | 启动 / 重新武装闹钟循环（幂等） | 需 `Authorization: Bearer <CONTROL_TOKEN>` |
| `/status` | 返回当前状态：`lastSetName`、`weatherText`、`alarmAt` 等 | 需 `Authorization: Bearer <CONTROL_TOKEN>` |

### 本地调试（可选）

```bash
cd worker
cp .dev.vars.example .dev.vars   # 填进各项密钥（BASE_NAME 走 wrangler.jsonc，不用写这里）
npm run dev                      # 本地起 Worker
# 另开一个终端：
curl -H "Authorization: Bearer $CONTROL_TOKEN" http://localhost:8787/start
curl -H "Authorization: Bearer $CONTROL_TOKEN" http://localhost:8787/status

npm run typecheck && npm run test   # 类型检查 + 单测
```

> 关于费用与连接：Worker 不会 24 小时常驻——每分钟唤醒一次、改完名字就断开 MTProto 连接、下次再用持久化的会话串重连。这样能避免被一直计费，挂在 Cloudflare 免费套餐上完全够用。更多实现细节见 [`worker/README.md`](worker/README.md)。

---

## 方式 B：Docker / VPS（原版，已有服务器的人）

### 一键脚本（最省事）

懒人路径，全程交互问你要什么填什么：

```bash
git clone https://github.com/clavulin/telegram-name-clock-weather.git
cd telegram-name-clock-weather
./install.sh
```

脚本会：检查 Docker（没装会问你装，默认装）→ 让你输入 API_ID/HASH → 在临时容器里交互登录生成 `TG_STRING_SESSION`（依次问你手机号、验证码、二次验证密码）→ 让你填昵称/时区/坐标 → 默认走免费的 Open-Meteo（也可选 QWeather）→ 写 `.env` → `docker compose up -d` → 贴最后几十行日志确认。

### 交互提示怎么填（两种方式通用）

不管是这里的 `./install.sh`、Worker 的 `npm run login`，还是后面手动用 Docker / Python 生成，登录时都会依次问这三项：

1. **手机号** —— 必须用国际格式 E.164：`+` 加国家区号，再接号码，**中间不要空格、不要连字符，并去掉本地拨号的前导 `0`**。这是你**要登录的那个 Telegram 账号本人**的手机号（用户账号，不是 bot）。

   | 国家/地区 | 本地号码 | 这里填 |
   |---|---|---|
   | 中国大陆 | 138 1234 5678 | `+8613812345678` |
   | 香港 | 9123 4567 | `+85291234567` |
   | 美国 | (415) 555-0123 | `+14155550123` |

2. **登录验证码** —— Telegram 把一串数字码发到你**其它已登录的 Telegram App**（没有别的在线设备时才会走短信）。原样填进来即可，每次登录都不一样。

3. **二次验证密码（2FA，提示 `please enter your password`）** —— **只有**你给账号开过「两步验证」时才会问到。
   - 开过 → 输入你当初**自己设的那个固定密码**（不是手机解锁密码，也不是上一步的验证码）。
   - 没开过 → **直接回车留空**。

   忘了这个密码：手机 Telegram → **Settings → Privacy and Security → Two-Step Verification** 里可重置或关闭，关掉后重新登录就不会再问。

### 手动开始（想自己控制每一步）

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

### 源码构建（可选）

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

## 生成会话串 `TG_STRING_SESSION`

> ⚠️ **两种部署方式的会话串格式不通用！** Cloudflare Worker 用 GramJS，Docker/Python 用 Telethon，互相不能复用。换部署方式必须重新生成。
>
> 不管哪种，都**在本地跑**，不要在服务器上跑——这一步需要交互输入手机号和验证码。三个提示分别填什么，照着上面[交互提示怎么填](#交互提示怎么填两种方式通用)填就行。

### A. 给 Cloudflare Worker 用（GramJS）

```bash
cd worker
npm install
npm run login
```

会依次问 `api_id` / `api_hash`（环境里有就自动跳过）、手机号、登录验证码、二次验证密码——填法见上面[交互提示怎么填](#交互提示怎么填两种方式通用)。最后打印在 `=== TG_STRING_SESSION ===` 之间的那串就是 Worker 用的 `TG_STRING_SESSION`。

### B. 给 Docker / Python 用（Telethon）

最省事：用项目镜像跑一个一次性容器，本机只要有 Docker，**不用装 Python / telethon**。把下面两个值换成你自己的，整段复制执行：

```bash
docker run --rm -it \
  -e TG_API_ID=你的API_ID \
  -e TG_API_HASH=你的API_HASH \
  --entrypoint python \
  ghcr.io/clavulin/telegram-name-clock-weather:latest -c '
import os
from telethon.sync import TelegramClient
from telethon.sessions import StringSession
with TelegramClient(StringSession(), int(os.environ["TG_API_ID"]), os.environ["TG_API_HASH"]) as c:
    print("\n\n=== TG_STRING_SESSION ===")
    print(c.session.save())
    print("=========================")
'
```

接着按上面[交互提示怎么填](#交互提示怎么填两种方式通用)输入手机号、验证码、二次验证密码。最后打印在 `=== TG_STRING_SESSION ===` 之间的那一长串就是结果，整段复制到 `.env` 的 `TG_STRING_SESSION=`。

> 跑 `./install.sh` 的话这一步是自动的，不用手动敲这条命令。

<details>
<summary>没有 Docker？也可以用本机 Python 跑</summary>

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

交互提示与上面完全一致。

</details>

## 配置项

下面这些两种方式通用：Docker 写进 `.env`，Cloudflare 写进 `wrangler.jsonc` 的 `vars`（密钥类用 `wrangler secret put`）。

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `TG_API_ID` | ✅ | — | my.telegram.org 拿的 API ID |
| `TG_API_HASH` | ✅ | — | my.telegram.org 拿的 API Hash |
| `TG_STRING_SESSION` | ✅ | — | 会话串（Worker 用 GramJS，Docker 用 Telethon，见上方） |
| `BASE_NAME` | ✅ | — | 动态部分前面的固定昵称，比如 `Alice` |
| `CONTROL_TOKEN` | Worker 必填 | — | 保护 `/start`、`/status` 的 Bearer 令牌（仅 Cloudflare 方式需要） |
| `TZ_NAME` | | `Australia/Sydney` | IANA 时区，**中国是 `Asia/Shanghai`，不是 `China/Shanghai`** |
| `TIME_FORMAT` | | `{time}` | 时间模板，`{time}` 替换为 `HH:MM` |
| `TIME_STYLE` | | `fancy` | 时间字体样式，见[样式预览](#样式预览) |
| `TEMP_STYLE` | | `fancy` | 温度字体样式，同上 |
| `AHEAD_SECONDS` | | `0` | 提前几秒切换到下一分钟（应对网络延迟） |
| `GUARD_SECONDS` | | `0.15` | 调度安全余量（秒），一般不动 |
| `WEATHER_ENABLED` | | `1` | `0` 关闭天气，只显示时间 |
| `WEATHER_REFRESH_SECONDS` | | `1800` | 天气拉取间隔，最小强制 60s |
| `TELEGRAM_DRY_RUN` | | `0` | `1` 只打印不真改资料、不连 Telegram（试运行用） |

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

**Telegram `FloodWaitError` / 日志反复 `[FLOOD]`**
触发了 profile 修改频率限制。等日志里提示的秒数过去（Worker 会自动按提示重排闹钟）；以后别把刷新参数调得太激进。

**`TG_STRING_SESSION` 报错**
多半是用错了格式。Cloudflare Worker 必须用 `npm run login`（GramJS）生成的串，Telethon 的串不通用——重新生成。

**名字被截断**
Telegram first_name 上限 64 字符。`BASE_NAME` 太长或样式占字符太多就会被砍；缩短 `BASE_NAME` 或换不那么"花"的样式。

**昵称没更新（Docker）**
看 `docker compose logs -f`：
- 没 `[TRY]` 行 → 调度循环卡住，看是否反复 `[ERR]`；
- 有 `[TRY]` 但没 `[CONFIRM]` → Telegram 端拒绝了，常见是 session 过期，重新生成 `TG_STRING_SESSION`。

**昵称没更新（Cloudflare）**
- `/status` 里 `alarmAt` 是 `null` → 调一次 `/start`；还是 `null` 就看日志里有没有配置校验报错。
- `/start` 或 `/status` 返回 401/503 → `CONTROL_TOKEN` 没设或没作为 Bearer 令牌带上。

更细的 Worker 运维说明见 [`worker/README.md`](worker/README.md)。

## 许可证

[MIT](LICENSE)
