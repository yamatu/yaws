import { shellQuote } from "./ssh.js";

export function renderInstallScript(opts: {
  machineId: number;
  wsUrl: string;
  key: string;
  intervalSec: number;
  agentRepo: string;
  releaseBaseUrl: string;
}) {
  const cfg = {
    url: opts.wsUrl,
    id: opts.machineId,
    key: opts.key,
    disk: "/",
    intervalSec: opts.intervalSec,
  };
  const cfgJson = JSON.stringify(cfg, null, 2);
  // Shell-quote so an operator-supplied repository or mirror URL can never inject shell syntax
  // into the root-level installer that is downloaded and piped to bash.
  const base = shellQuote(opts.releaseBaseUrl.replace(/\/+$/, ""));
  const repo = shellQuote(opts.agentRepo.trim());

  return `#!/usr/bin/env bash
set -euo pipefail

if [ "\${EUID:-\$(id -u)}" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo -E bash "$0" "$@"
  fi
  echo "Please run as root." >&2
  exit 1
fi

FORCE=0
CHECK_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --check) CHECK_ONLY=1 ;;
    -h|--help)
      echo "Usage: $0 [--check] [--force]"
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

OS="\$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="\$(uname -m)"
if [ "\$OS" != "linux" ]; then
  echo "Unsupported OS: \$OS (only linux supported by this installer)" >&2
  exit 1
fi

case "\$ARCH" in
  x86_64|amd64) ASSET="yaws-agent-linux-amd64" ;;
  aarch64|arm64) ASSET="yaws-agent-linux-arm64" ;;
  *) echo "Unsupported arch: \$ARCH" >&2; exit 1 ;;
esac

BIN="/usr/local/bin/yaws-agent"
CFG="/etc/yaws-agent.json"
SVC="/etc/systemd/system/yaws-agent.service"

REPO=${repo}
BASE=${base}

LATEST_TAG=""
if [ -n "$REPO" ]; then
  API="https://api.github.com/repos/$REPO/releases/latest"
  if command -v curl >/dev/null 2>&1; then
    JSON="\$(curl -fsSL "\$API" 2>/dev/null || true)"
  elif command -v wget >/dev/null 2>&1; then
    JSON="\$(wget -qO- "\$API" 2>/dev/null || true)"
  else
    JSON=""
  fi
  if [ -n "\$JSON" ]; then
    LATEST_TAG="\$(printf '%s' "\$JSON" | tr -d '\r' | grep -m1 '\"tag_name\"' | sed -E 's/.*\"tag_name\"[[:space:]]*:[[:space:]]*\"([^\"]+)\".*/\\1/')"
  fi

  # If BASE is a GitHub release URL, prefer downloading by tag so "latest" and version checks stay in sync.
  if [ -n "\$LATEST_TAG" ] && printf '%s' "\$BASE" | grep -q '^https://github.com/'; then
    BASE="https://github.com/$REPO/releases/download/\$LATEST_TAG"
  fi
fi

INSTALLED_TAG=""
if [ -x "\$BIN" ]; then
  INSTALLED_TAG="\$("\$BIN" -version 2>/dev/null | head -n1 | tr -d '\r' || true)"
fi

if [ "\$CHECK_ONLY" -eq 1 ]; then
  echo "installed=\${INSTALLED_TAG:-none}"
  echo "latest=\${LATEST_TAG:-unknown}"
  exit 0
fi

NEED_DOWNLOAD=0
if [ ! -x "\$BIN" ] || [ "\$FORCE" -eq 1 ]; then
  NEED_DOWNLOAD=1
elif [ -n "\$LATEST_TAG" ]; then
  # If the installed agent doesn't support -version, treat it as outdated.
  if [ -z "\$INSTALLED_TAG" ] || [ "\$INSTALLED_TAG" != "\$LATEST_TAG" ]; then
    NEED_DOWNLOAD=1
  fi
fi

TMP="\$(mktemp -d)"
trap 'rm -rf "\$TMP"' EXIT

if [ "\$NEED_DOWNLOAD" -eq 1 ]; then
  echo "[1/4] Downloading agent: \$BASE/\$ASSET (installed=\${INSTALLED_TAG:-none} latest=\${LATEST_TAG:-unknown})"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "\$BASE/\$ASSET" -o "\$TMP/yaws-agent"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "\$TMP/yaws-agent" "\$BASE/\$ASSET"
  else
    echo "Need curl or wget." >&2
    exit 1
  fi
  install -m 0755 "\$TMP/yaws-agent" "\$BIN"
else
  echo "[1/4] Agent already latest: \${INSTALLED_TAG:-unknown}"
fi

echo "[2/4] Writing config: \$CFG"
cat > "\$CFG" <<'JSON'
${cfgJson}
JSON
chmod 0600 "\$CFG"

echo "[3/4] Installing service"
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  cat > "\$SVC" <<'UNIT'
[Unit]
Description=YAWS Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/yaws-agent -config /etc/yaws-agent.json
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable --now yaws-agent
  systemctl restart yaws-agent
  echo "[4/4] Done. systemctl status yaws-agent --no-pager"
else
  echo "[3/4] systemd not found; running in background"
  nohup "\$BIN" -config "\$CFG" >/var/log/yaws-agent.log 2>&1 &
  echo "[4/4] Done. log: /var/log/yaws-agent.log"
fi
`;
}
