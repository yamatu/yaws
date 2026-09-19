import { shellQuote } from "./ssh.js";
import { trimBase, type AgentProvider } from "./agent-release.js";

export type InstallScriptOptions = {
  machineId: number;
  wsUrl: string;
  key: string;
  intervalSec: number;
  /** Where the agent may be downloaded from, in the order to try them. */
  order: AgentProvider[];
  /** Empty values disable the matching provider. */
  githubRepo: string;
  giteeRepo: string;
  releaseTag: string;
  githubBase: string;
  giteeBase: string;
  /** Panel origin used for the "controller ships the binary" source. */
  controllerBase: string;
  /** Version the panel ships; "" means "cannot tell, only install when missing". */
  targetVersion: string;
};

/**
 * Builds the root installer for one machine.
 *
 * The script tries every candidate source in `order` until one hands over a
 * binary that actually runs (`-version` answers), verifies the published SHA256
 * when one is available, writes `/etc/yaws-agent.json`, and registers a systemd
 * unit (or backgrounds the agent when there is no systemd).
 *
 * Every value that comes from the database or from an operator-controlled
 * setting is shell-quoted, because this file is piped into `bash` as root.
 */
export function renderInstallScript(opts: InstallScriptOptions) {
  const cfg = {
    url: opts.wsUrl,
    id: opts.machineId,
    key: opts.key,
    disk: "/",
    intervalSec: opts.intervalSec,
  };
  const cfgJson = JSON.stringify(cfg, null, 2);
  const q = shellQuote;
  const order = opts.order.filter((provider) =>
    provider === "controller" || provider === "gitee" || provider === "github",
  );

  return `#!/usr/bin/env bash
set -euo pipefail

if [ "\${EUID:-\$(id -u)}" -ne 0 ]; then
  # Re-run as root from the same file. Piped installs (\`curl ... | bash\`) and
  # the panel's one-click install have no terminal, so sudo must not prompt.
  if command -v sudo >/dev/null 2>&1 && [ -f "\$0" ]; then
    if [ -t 0 ]; then
      exec sudo -E bash "\$0" "\$@"
    fi
    exec sudo -n -E bash "\$0" "\$@"
  fi
  echo "This installer has to run as root." >&2
  echo "Save it first, then run: sudo bash <file> [--force]" >&2
  exit 1
fi

FORCE=0
CHECK_ONLY=0
while [ \$# -gt 0 ]; do
  case "\$1" in
    --force) FORCE=1 ;;
    --check) CHECK_ONLY=1 ;;
    -h|--help)
      echo "Usage: \$0 [--check] [--force]"
      echo "  --check  print the installed and bundled agent versions, change nothing"
      echo "  --force  download and install even when the version already matches"
      exit 0
      ;;
    *) echo "Unknown arg: \$1" >&2; exit 2 ;;
  esac
  shift
done

# BEGIN YAWS-GENERATED (values from the panel, all shell-quoted)
ORDER=${q(order.join(" "))}
GITHUB_REPO=${q(opts.githubRepo.trim())}
GITEE_REPO=${q(opts.giteeRepo.trim())}
RELEASE_TAG=${q(opts.releaseTag.trim())}
GITHUB_BASE=${q(trimBase(opts.githubBase))}
GITEE_BASE=${q(trimBase(opts.giteeBase))}
CONTROLLER_BASE=${q(trimBase(opts.controllerBase))}
TARGET_VERSION=${q(opts.targetVersion.trim())}
# END YAWS-GENERATED

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

have() { command -v "\$1" >/dev/null 2>&1; }

fetch() {
  # fetch <url> <file>
  if have curl; then
    curl -fsSL --connect-timeout 10 --max-time 600 "\$1" -o "\$2" 2>/dev/null
  elif have wget; then
    wget -q -T 30 -O "\$2" "\$1" 2>/dev/null
  else
    echo "Need curl or wget on this host." >&2
    return 2
  fi
}

fetch_api() {
  # Release metadata only: a failure means "this source is unusable", never a
  # hard error, so one blocked provider cannot stop the install.
  if have curl; then
    curl -fsSL --connect-timeout 5 --max-time 20 -H 'User-Agent: yaws-installer' "\$1" 2>/dev/null
  elif have wget; then
    wget -q -T 15 -O - "\$1" 2>/dev/null
  fi
  return 0
}

json_tag() {
  printf '%s' "\$1" | tr -d '\\r' | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n1
}

# A captive portal or a wrong architecture must never end up in /usr/local/bin:
# the download only counts when the binary answers \`-version\`.
usable() {
  [ -s "\$1" ] || return 1
  chmod 0755 "\$1" 2>/dev/null || true
  "\$1" -version >/dev/null 2>&1
}

# Verify against a published SHA256SUMS file. A missing file or a missing entry
# is not fatal (old releases, mirrors), a mismatch is.
verify() {
  # verify <file> <checksums> <asset>
  [ -s "\$2" ] || return 0
  expected="\$(awk -v a="\$3" '{ for (i = 1; i <= NF; i++) if (\$i == a || \$i == "*" a) { print \$1; exit } }' "\$2" 2>/dev/null)"
  [ -n "\$expected" ] || return 0
  if have sha256sum; then
    actual="\$(sha256sum "\$1" | awk '{print \$1}')"
  elif have shasum; then
    actual="\$(shasum -a 256 "\$1" | awk '{print \$1}')"
  else
    return 0
  fi
  if [ "\$actual" != "\$expected" ]; then
    echo "    checksum mismatch (expected \$expected, got \$actual)" >&2
    return 1
  fi
  echo "    checksum ok"
}

latest_base() {
  # latest_base <provider> -> prints the release download base
  if [ "\$1" = "github" ]; then
    [ -n "\$GITHUB_REPO" ] || return 1
    if [ -n "\$GITHUB_BASE" ]; then echo "\$GITHUB_BASE"; return 0; fi
    json="\$(fetch_api "https://api.github.com/repos/\$GITHUB_REPO/releases/latest")"
    tag="\$(json_tag "\$json")"
    [ -n "\$tag" ] || return 1
    echo "https://github.com/\$GITHUB_REPO/releases/download/\$tag"
  else
    [ -n "\$GITEE_REPO" ] || return 1
    if [ -n "\$GITEE_BASE" ]; then echo "\$GITEE_BASE"; return 0; fi
    json="\$(fetch_api "https://gitee.com/api/v5/repos/\$GITEE_REPO/releases/latest")"
    tag="\$(json_tag "\$json")"
    [ -n "\$tag" ] || return 1
    echo "https://gitee.com/\$GITEE_REPO/releases/download/\$tag"
  fi
}

try_source() {
  # try_source <provider>; on success \$TMP/dl holds a runnable agent
  if [ "\$1" = "controller" ]; then
    [ -n "\$CONTROLLER_BASE" ] || return 1
    url="\$CONTROLLER_BASE/api/agent/binary/\$ASSET"
    echo "  - 主控自带: \$url"
    fetch "\$url" "\$TMP/dl" || { echo "    download failed" >&2; return 1; }
    fetch "\$url.sha256" "\$TMP/SHA256SUMS" || true
    verify "\$TMP/dl" "\$TMP/SHA256SUMS" "\$ASSET" || return 1
  else
    base=""
    if ! base="\$(latest_base "\$1")"; then
      echo "  - \$1: 没有可用的发行版" >&2
      return 1
    fi
    url="\$base/\$ASSET"
    echo "  - \$1: \$url"
    fetch "\$url" "\$TMP/dl" || { echo "    download failed" >&2; return 1; }
    fetch "\$base/SHA256SUMS" "\$TMP/SHA256SUMS" || true
    verify "\$TMP/dl" "\$TMP/SHA256SUMS" "\$ASSET" || return 1
  fi
  usable "\$TMP/dl" || { echo "    not a runnable agent binary" >&2; return 1; }
  SOURCE_USED="\$1"
  return 0
}

INSTALLED_TAG=""
if [ -x "\$BIN" ]; then
  INSTALLED_TAG="\$("\$BIN" -version 2>/dev/null | head -n1 | tr -d '\\r' || true)"
fi

if [ "\$CHECK_ONLY" -eq 1 ]; then
  echo "installed=\${INSTALLED_TAG:-none}"
  echo "target=\${TARGET_VERSION:-unknown}"
  echo "order=\$ORDER"
  exit 0
fi

NEED_DOWNLOAD=0
if [ ! -x "\$BIN" ] || [ "\$FORCE" -eq 1 ]; then
  NEED_DOWNLOAD=1
elif [ -n "\$TARGET_VERSION" ] && [ "\$INSTALLED_TAG" != "\$TARGET_VERSION" ]; then
  NEED_DOWNLOAD=1
fi

TMP="\$(mktemp -d)"
trap 'rm -rf "\$TMP"' EXIT

if [ "\$NEED_DOWNLOAD" -eq 1 ]; then
  echo "[1/4] 获取探针 (已安装=\${INSTALLED_TAG:-none} 目标=\${TARGET_VERSION:-unknown})"
  SOURCE_USED=""
  for provider in \$ORDER; do
    if try_source "\$provider"; then break; fi
  done
  if [ -z "\$SOURCE_USED" ]; then
    echo "所有下载来源都失败了 (\$ORDER)。" >&2
    echo "可在主控 .env 配置 AGENT_RELEASE_TAG / AGENT_BINARY_DIR，或手动上传探针到 \$BIN。" >&2
    exit 1
  fi
  install -m 0755 "\$TMP/dl" "\$BIN"
  echo "    已通过 \$SOURCE_USED 安装"
else
  echo "[1/4] 探针已是最新版本: \${INSTALLED_TAG:-unknown}（--force 可强制重装）"
fi

echo "[2/4] 写入配置: \$CFG"
cat > "\$CFG" <<'JSON'
${cfgJson}
JSON
chmod 0600 "\$CFG"

echo "[3/4] 安装 systemd 服务"
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
  systemctl enable yaws-agent >/dev/null 2>&1 || true
  systemctl restart yaws-agent
  echo "[4/4] 完成。systemctl status yaws-agent --no-pager"
else
  echo "[3/4] 未检测到 systemd，改为后台运行"
  pkill -f "yaws-agent -config \$CFG" >/dev/null 2>&1 || true
  nohup "\$BIN" -config "\$CFG" >/var/log/yaws-agent.log 2>&1 &
  echo "[4/4] 完成。日志: /var/log/yaws-agent.log"
fi

echo "已安装版本: \$("\$BIN" -version 2>/dev/null | head -n1 || echo unknown)"
`;
}
