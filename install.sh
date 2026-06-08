#!/usr/bin/env bash
# Telegram Name Clock Weather - 一键安装向导
# 用法：在仓库根目录运行 ./install.sh
set -euo pipefail

# ---------- 输出 ----------
if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ -n "${TERM:-}" ]] && tput colors >/dev/null 2>&1; then
  C_RESET=$(tput sgr0); C_BOLD=$(tput bold)
  C_BLUE=$(tput setaf 4); C_GREEN=$(tput setaf 2)
  C_YELLOW=$(tput setaf 3); C_RED=$(tput setaf 1)
else
  C_RESET=""; C_BOLD=""; C_BLUE=""; C_GREEN=""; C_YELLOW=""; C_RED=""
fi

info() { printf "%s[*]%s %s\n" "$C_BLUE"   "$C_RESET" "$*"; }
ok()   { printf "%s[✓]%s %s\n" "$C_GREEN"  "$C_RESET" "$*"; }
warn() { printf "%s[!]%s %s\n" "$C_YELLOW" "$C_RESET" "$*"; }
err()  { printf "%s[x]%s %s\n" "$C_RED"    "$C_RESET" "$*" >&2; }
step() { printf "\n%s== %s ==%s\n" "$C_BOLD" "$*" "$C_RESET"; }

ask() {
  local prompt="$1" default="${2:-}" reply
  if [[ -n "$default" ]]; then
    read -r -p "$prompt [$default]: " reply
    reply="${reply:-$default}"
  else
    read -r -p "$prompt: " reply
  fi
  printf "%s" "$reply"
}

confirm() {
  local prompt="$1" default="${2:-N}" reply hint
  case "$default" in Y|y) hint="Y/n" ;; *) hint="y/N" ;; esac
  read -r -p "$prompt [$hint]: " reply
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy]$ ]]
}

# ---------- 工作目录 ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ ! -f "docker-compose.yml" || ! -f ".env.example" ]]; then
  err "请在仓库根目录运行（当前目录找不到 docker-compose.yml / .env.example）"
  exit 1
fi

# ---------- 临时目录清理 ----------
WORK_DIR=""
cleanup() { [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]] && rm -rf "$WORK_DIR"; }
trap cleanup EXIT

# ---------- 横幅 ----------
cat <<EOF
${C_BOLD}Telegram Name Clock Weather — 一键安装向导${C_RESET}

会带你走完：
  1) 检查 / 安装 Docker
  2) 输入 Telegram API_ID / API_HASH
  3) 在容器里交互生成 TG_STRING_SESSION（手机号 + 验证码）
  4) 昵称、时区、坐标
  5) 写 .env，启动容器

${C_YELLOW}⚠️  TG_STRING_SESSION 等同于完整 Telegram 登录凭证。${C_RESET}
${C_YELLOW}    脚本只把它写到本地 .env（权限 600），不上传任何地方。${C_RESET}

EOF
confirm "继续？" "Y" || exit 0

# ---------- 1. Docker ----------
step "1/6 检查 / 安装 Docker"

# 非 root 且有 sudo 时，后续提权都走 sudo
SUDO=""
if [[ "$(id -u)" -ne 0 ]] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi

install_docker() {
  local os; os="$(uname -s)"
  if [[ "$os" != "Linux" ]]; then
    err "自动安装只支持 Linux；$os 请手动装 Docker Desktop：https://docs.docker.com/desktop/"
    exit 1
  fi
  if ! command -v curl >/dev/null 2>&1; then
    err "自动安装需要 curl，但没找到。先装 curl，或手动装 Docker：https://docs.docker.com/engine/install/"
    exit 1
  fi
  if [[ "$(id -u)" -ne 0 && -z "$SUDO" ]]; then
    err "装 Docker 需要 root，但没找到 sudo。请用 root 重跑，或手动安装：https://docs.docker.com/engine/install/"
    exit 1
  fi
  info "用 Docker 官方脚本安装（curl -fsSL https://get.docker.com | sh）…"
  if ! curl -fsSL https://get.docker.com | $SUDO sh; then
    err "自动安装失败，请手动安装：https://docs.docker.com/engine/install/"
    exit 1
  fi
  if command -v systemctl >/dev/null 2>&1; then
    $SUDO systemctl enable --now docker >/dev/null 2>&1 || true
  fi
  # 把当前用户加进 docker 组（下次登录生效；本次会话先用 sudo 兜底）
  [[ -n "$SUDO" ]] && $SUDO usermod -aG docker "$(id -un)" >/dev/null 2>&1 || true
  ok "Docker 安装完成"
}

if ! command -v docker >/dev/null 2>&1; then
  warn "没检测到 Docker。"
  if confirm "现在自动安装 Docker？" "Y"; then
    install_docker
  else
    err "需要 Docker 才能继续。手动安装：https://docs.docker.com/engine/install/"
    exit 1
  fi
fi

# daemon 常见没自启，尝试拉起来
if ! docker info >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1; then
  if [[ "$(id -u)" -eq 0 ]]; then
    systemctl start docker >/dev/null 2>&1 || true
  elif [[ -n "$SUDO" ]]; then
    $SUDO systemctl start docker >/dev/null 2>&1 || true
  fi
fi

# 决定怎么跟 Docker 说话：能直连就直连，否则用 sudo 兜底（应对刚装完还没进 docker 组）
DOCKER=(docker)
if docker info >/dev/null 2>&1; then
  DOCKER=(docker)
elif [[ -n "$SUDO" ]] && sudo docker info >/dev/null 2>&1; then
  DOCKER=(sudo docker)
  warn "当前用户还不能直连 Docker（多半是没加入 docker 组），本次先用 sudo 兜底。"
  warn "之后重新登录一次（或运行 newgrp docker）就能去掉 sudo。"
else
  err "docker info 失败：daemon 没启动，或当前用户不在 docker 组里。"
  err "排查：先 sudo systemctl start docker，再确认你在 docker 组（newgrp docker 或重新登录）。"
  exit 1
fi

# compose 跟上面用同样的（是否 sudo）前缀
if "${DOCKER[@]}" compose version >/dev/null 2>&1; then
  COMPOSE=("${DOCKER[@]}" compose)
elif command -v docker-compose >/dev/null 2>&1; then
  if [[ "${DOCKER[0]}" == "sudo" ]]; then COMPOSE=(sudo docker-compose); else COMPOSE=(docker-compose); fi
else
  err "找不到 docker compose（v2 插件或 v1 都行）。"
  exit 1
fi
ok "Docker 就绪"

# ---------- 已有 .env 的处理 ----------
SKIP_CONFIG=0
if [[ -f ".env" ]]; then
  warn "已经存在 .env"
  echo "  [k] 保留现有 .env，直接到启动步骤"
  echo "  [b] 备份再重新生成"
  echo "  [q] 退出"
  read -r -p "选择 [k/b/q] (默认 k): " choice
  case "${choice:-k}" in
    b|B)
      backup=".env.bak.$(date +%Y%m%d_%H%M%S)"
      mv .env "$backup"
      ok "已备份到 $backup"
      ;;
    q|Q) exit 0 ;;
    *) info "保留现有 .env"; SKIP_CONFIG=1 ;;
  esac
fi

if [[ "$SKIP_CONFIG" != "1" ]]; then

# ---------- 2. API_ID / API_HASH ----------
step "2/6 Telegram API 凭证"
cat <<EOF
还没有的话，去 https://my.telegram.org → API development tools 申请。
${C_YELLOW}一个 Telegram 账号只能创建一次，记得保存好。${C_RESET}
EOF

while :; do
  TG_API_ID=$(ask "API_ID（纯数字）")
  [[ "$TG_API_ID" =~ ^[0-9]+$ ]] && break
  err "API_ID 必须是数字"
done

while :; do
  TG_API_HASH=$(ask "API_HASH（32 位十六进制）")
  [[ "$TG_API_HASH" =~ ^[a-fA-F0-9]{32}$ ]] && break
  err "API_HASH 必须是 32 位十六进制"
done

# ---------- 3. SESSION ----------
step "3/6 生成 TG_STRING_SESSION"
cat <<EOF
接下来拉项目镜像，里面已经装好 telethon。
你会被依次问：
  • 手机号（带国际区号，如 +8613800000000）
  • Telegram 发来的验证码
  • 如果开了二次验证，还会问密码
完成后 session 自动写回到本地 .env。
EOF
read -r -p "回车继续… " _

IMAGE="ghcr.io/clavulin/telegram-name-clock-weather:latest"
info "拉取镜像 $IMAGE"
"${DOCKER[@]}" pull "$IMAGE" >/dev/null
ok "镜像就绪"

WORK_DIR=$(mktemp -d)
cat > "$WORK_DIR/gen.py" <<'PYEOF'
import os
from telethon.sync import TelegramClient
from telethon.sessions import StringSession

api_id = int(os.environ["TG_API_ID"])
api_hash = os.environ["TG_API_HASH"]

print()
print("[INFO] 登录流程开始")
with TelegramClient(StringSession(), api_id, api_hash) as client:
    session = client.session.save()
    with open("/out/session", "w") as f:
        f.write(session)
print()
print("[OK] Session 已生成，返回安装脚本。")
PYEOF

if ! "${DOCKER[@]}" run --rm -it \
    --user root \
    -e TG_API_ID="$TG_API_ID" \
    -e TG_API_HASH="$TG_API_HASH" \
    -v "$WORK_DIR:/out" \
    --entrypoint python \
    "$IMAGE" \
    /out/gen.py; then
  err "Session 生成失败（可能输错验证码、网络断了，或者 API_ID/HASH 不对）"
  exit 1
fi

if [[ ! -s "$WORK_DIR/session" ]]; then
  err "没拿到 session 字符串"
  exit 1
fi

TG_STRING_SESSION=$(cat "$WORK_DIR/session")
ok "拿到 session（${#TG_STRING_SESSION} 字符）"

# ---------- 4. 昵称 / 时区 ----------
step "4/6 昵称、时区"

while :; do
  BASE_NAME=$(ask "BASE_NAME（你想固定显示的昵称，比如 Alice）")
  [[ -n "$BASE_NAME" ]] && break
  err "不能为空"
done

DEFAULT_TZ="Asia/Shanghai"
if command -v timedatectl >/dev/null 2>&1; then
  detected=$(timedatectl show -p Timezone --value 2>/dev/null || true)
  [[ -n "$detected" ]] && DEFAULT_TZ="$detected"
elif [[ -f /etc/timezone ]]; then
  DEFAULT_TZ=$(tr -d '[:space:]' < /etc/timezone)
fi
cat <<EOF
时区用 IANA tz 名（中国是 Asia/Shanghai，不是 China/Shanghai）。
常见：Asia/Shanghai, Asia/Tokyo, Europe/London, America/New_York, Australia/Sydney
EOF
TZ_NAME=$(ask "时区" "$DEFAULT_TZ")

# ---------- 5. 坐标 ----------
step "5/6 坐标（默认 Open-Meteo，免费免注册）"
cat <<EOF
常用坐标参考：
  北京  39.90, 116.41    上海  31.23, 121.47
  深圳  22.54, 114.06    杭州  30.27, 120.15
  香港  22.32, 114.17    东京  35.68, 139.69
  伦敦  51.51,  -0.13    纽约  40.71, -74.01
EOF

while :; do
  OPEN_METEO_LATITUDE=$(ask "纬度 (-90 ~ 90)")
  if [[ "$OPEN_METEO_LATITUDE" =~ ^-?[0-9]+(\.[0-9]+)?$ ]] \
     && awk -v v="$OPEN_METEO_LATITUDE" 'BEGIN{exit (v>=-90 && v<=90)?0:1}'; then
    break
  fi
  err "纬度必须是 -90 ~ 90 的数字"
done

while :; do
  OPEN_METEO_LONGITUDE=$(ask "经度 (-180 ~ 180)")
  if [[ "$OPEN_METEO_LONGITUDE" =~ ^-?[0-9]+(\.[0-9]+)?$ ]] \
     && awk -v v="$OPEN_METEO_LONGITUDE" 'BEGIN{exit (v>=-180 && v<=180)?0:1}'; then
    break
  fi
  err "经度必须是 -180 ~ 180 的数字"
done

# ---------- 可选 QWeather ----------
USE_QW=0
QW_HOST=""; QW_LOCATION=""; QW_PROJECT_ID=""; QW_KEY_ID=""
QW_PRIVATE_KEY_B64=""; QW_LANG="zh"; QW_UNIT="m"

echo
if confirm "想再配 QWeather 拿更准的国内天气？（不配也能用，跳过即可）" "N"; then
  USE_QW=1
  cat <<EOF
QWeather 控制台：https://dev.qweather.com/
需要：专属 API host、项目 ID、密钥 ID、私钥 PEM 文件。
EOF
  QW_HOST=$(ask "QW_HOST（控制台分配的专属 host，不带 https://）")
  QW_LOCATION=$(ask "QW_LOCATION（lon,lat 或 LocationID）" "$OPEN_METEO_LONGITUDE,$OPEN_METEO_LATITUDE")
  QW_PROJECT_ID=$(ask "QW_PROJECT_ID")
  QW_KEY_ID=$(ask "QW_KEY_ID")

  while :; do
    kpath=$(ask "私钥 PEM 文件路径（控制台下载的那个 .pem）")
    if [[ -r "$kpath" ]]; then
      # PEM 多行不适合 dotenv，把 base64 部分单行存为 base64 DER，main.py 会自动识别
      QW_PRIVATE_KEY_B64=$(grep -v '^-----' "$kpath" | tr -d '[:space:]')
      if [[ -n "$QW_PRIVATE_KEY_B64" ]]; then
        break
      fi
      err "文件读到了但没解析到 PEM 内容，确认格式"
    else
      err "读不到 $kpath"
    fi
  done
fi

# ---------- 6. 写 .env ----------
step "6/6 写入 .env"

{
  echo "# Generated by install.sh on $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "TG_API_ID=$TG_API_ID"
  echo "TG_API_HASH=$TG_API_HASH"
  echo "TG_STRING_SESSION=$TG_STRING_SESSION"
  echo "BASE_NAME=$BASE_NAME"
  echo "TZ_NAME=$TZ_NAME"
  echo "TIME_FORMAT={time}"
  echo "TIME_STYLE=fancy"
  echo "TEMP_STYLE=fancy"
  echo "AHEAD_SECONDS=0"
  echo "GUARD_SECONDS=0.2"
  echo "WEATHER_ENABLED=1"
  echo "WEATHER_REFRESH_SECONDS=1800"
  echo "OPEN_METEO_LATITUDE=$OPEN_METEO_LATITUDE"
  echo "OPEN_METEO_LONGITUDE=$OPEN_METEO_LONGITUDE"
  if [[ "$USE_QW" == "1" ]]; then
    echo "QW_HOST=$QW_HOST"
    echo "QW_LOCATION=$QW_LOCATION"
    echo "QW_PROJECT_ID=$QW_PROJECT_ID"
    echo "QW_KEY_ID=$QW_KEY_ID"
    echo "QW_PRIVATE_KEY=$QW_PRIVATE_KEY_B64"
    echo "QW_JWT_TTL_SECONDS=900"
    echo "QW_LANG=$QW_LANG"
    echo "QW_UNIT=$QW_UNIT"
  fi
} > .env

chmod 600 .env
ok ".env 已写入并设为 600 权限"

fi  # SKIP_CONFIG

# ---------- 启动 ----------
step "启动容器"
info "拉取最新镜像"
"${COMPOSE[@]}" pull
info "启动"
"${COMPOSE[@]}" up -d

sleep 2

echo
ok "搞定！容器已经在跑了。"
cat <<EOF

常用命令：
  看日志：  ${C_BOLD}${COMPOSE[*]} logs -f${C_RESET}
  停止：    ${C_BOLD}${COMPOSE[*]} down${C_RESET}
  重启：    ${C_BOLD}${COMPOSE[*]} restart${C_RESET}
  改配置：  编辑 ${C_BOLD}.env${C_RESET} 再 ${C_BOLD}${COMPOSE[*]} up -d${C_RESET}

刚才那 30 行日志（看到 ${C_BOLD}[CONFIRM]${C_RESET} 就成功了）：
EOF
echo
"${COMPOSE[@]}" logs --tail=30 || true
echo
ok "完成。"
