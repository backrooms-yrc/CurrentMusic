#!/usr/bin/env bash
# Install/update the optional LDDC lyrics provider for CurrentMusic.
#
# LDDC is GPL-3.0-only and is installed as a separate program under /opt/lddc.
# Its source is not copied into this repository. The bridge only talks to it
# over 127.0.0.1 HTTP, keeping the main backend stdlib-only.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LDDC_ROOT="${LDDC_ROOT:-/opt/lddc}"
LDDC_SRC="${LDDC_SRC:-$LDDC_ROOT/src}"
LDDC_VENV="${LDDC_VENV:-$LDDC_ROOT/venv}"
LDDC_REPO="${LDDC_REPO:-https://github.com/chenmozhijin/LDDC.git}"
LDDC_COMMIT="${LDDC_COMMIT:-84631e8cd011fcc3f71ca0ae017e2c9758958ffc}"
LDDC_PORT="${LDDC_PORT:-3015}"
SERVICE_FILE="/etc/systemd/system/currentmusic-lddc.service"
BACKEND_DROPIN_DIR="/etc/systemd/system/currentmusic.service.d"
BACKEND_DROPIN="$BACKEND_DROPIN_DIR/lddc.conf"
ENV_FILE="$LDDC_ROOT/bridge.env"

if [[ $EUID -ne 0 ]]; then
  echo "请用 root 运行：sudo $0" >&2
  exit 1
fi

for cmd in git curl; do
  command -v "$cmd" >/dev/null || { echo "缺少 $cmd" >&2; exit 1; }
done

echo "==> LDDC 源码 $LDDC_COMMIT"
if [[ ! -d "$LDDC_SRC/.git" ]]; then
  rm -rf "$LDDC_SRC"
  mkdir -p "$(dirname "$LDDC_SRC")"
  git clone --filter=blob:none "$LDDC_REPO" "$LDDC_SRC"
fi
git -C "$LDDC_SRC" remote set-url origin "$LDDC_REPO"
if ! git -C "$LDDC_SRC" fetch --depth 1 origin "$LDDC_COMMIT"; then
  git -C "$LDDC_SRC" fetch origin
fi
git -C "$LDDC_SRC" checkout --force --detach "$LDDC_COMMIT"
git -C "$LDDC_SRC" clean -fdq

echo "==> Python 依赖（不安装 PySide6）"
UV="$(command -v uv || true)"
if [[ -z "$UV" && -x /root/.local/bin/uv ]]; then
  UV=/root/.local/bin/uv
fi
if [[ -n "$UV" ]]; then
  if [[ ! -x "$LDDC_VENV/bin/python" ]]; then
    "$UV" venv --python "${LDDC_PYTHON:-3.11}" "$LDDC_VENV"
  fi
  "$UV" pip install --python "$LDDC_VENV/bin/python" -r "$REPO_DIR/deploy/lddc-requirements.txt"
else
  if [[ ! -x "$LDDC_VENV/bin/python" ]]; then
    python3 -m venv "$LDDC_VENV"
  fi
  "$LDDC_VENV/bin/python" -m pip install -r "$REPO_DIR/deploy/lddc-requirements.txt"
fi

echo "==> 本机访问令牌"
install -d -m 755 "$LDDC_ROOT"
if [[ ! -f "$ENV_FILE" ]]; then
  TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
  umask 077
  printf 'LDDC_TOKEN=%s\nLDDC_SRC=%s\n' "$TOKEN" "$LDDC_SRC" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi
if ! grep -q '^LDDC_SRC=' "$ENV_FILE"; then
  printf 'LDDC_SRC=%s\n' "$LDDC_SRC" >> "$ENV_FILE"
fi
TOKEN="$(sed -n 's/^LDDC_TOKEN=//p' "$ENV_FILE" | head -1)"
if [[ -z "$TOKEN" ]]; then
  echo "$ENV_FILE 缺少 LDDC_TOKEN" >&2
  exit 1
fi

echo "==> systemd 服务"
sed -e "s|/srv/currentmusic|$REPO_DIR|g" \
    -e "s|/opt/lddc/venv|$LDDC_VENV|g" \
    -e "s|/opt/lddc/bridge.env|$ENV_FILE|g" \
    -e "s|--port 3015|--port $LDDC_PORT|g" \
    "$REPO_DIR/deploy/currentmusic-lddc.service" > "$SERVICE_FILE"
chmod 644 "$SERVICE_FILE"
install -d -m 755 "$BACKEND_DROPIN_DIR"
umask 077
cat > "$BACKEND_DROPIN" <<EOF
[Service]
Environment="CM_LDDC_URL=http://127.0.0.1:$LDDC_PORT"
Environment="CM_LDDC_TOKEN=$TOKEN"
EOF
chmod 600 "$BACKEND_DROPIN"

systemctl daemon-reload
systemctl enable --now currentmusic-lddc
systemctl restart currentmusic-lddc
systemctl restart currentmusic

echo "==> 健康检查"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$LDDC_PORT/health" >/dev/null 2>&1; then
    curl -sS "http://127.0.0.1:$LDDC_PORT/health" | python3 -m json.tool
    echo "LDDC provider 已启用（backend 已重启）。"
    exit 0
  fi
  sleep 0.5
done

echo "LDDC bridge 未通过健康检查，请查看：journalctl -u currentmusic-lddc -n 100 --no-pager" >&2
exit 1
