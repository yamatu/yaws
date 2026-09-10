# YAWS (Yet Another Watchdog System)

轻量级的“主控 + 被控探针”监控系统（Node.js + React + SQLite + WebSocket + Go Agent），支持公开状态页与后台管理。

## 主要特性

**主控（Web）**

- 账号密码登录；后台可修改用户名/密码
- 机器管理：新增/编辑/删除；自定义分组（地区/云厂商/用途…）
- 多视图：卡片/列表；列表支持点击展开详情
- 排序：
  - 自定义顺序（列表拖拽并保存）
  - 到期剩余天数升序
  - 仅离线机器（没有离线则显示为空）
- 指标：CPU/内存/磁盘、load(1/5/15)、流量（累计 RX/TX）、网速（按差值计算）
- 每月流量：自动按月统计 RX/TX（跨月自动归零重新统计）
- 到期信息（站内展示）：到期时间、购买金额、计费周期（月/季/半年/年/两年/三年）、自动续费开关（仅展示）
- Telegram 通知：离线/恢复在线/到期提醒（后台可配置；或使用环境变量）
- 堡垒机：登录后台后统一查看已配置 SSH 主机、进入 WebSSH，并查看/断开活动会话；SSH 会话由主控服务端代理并记录审计信息
- 延迟监控：选择来源机器和目标 IP/域名，由该机器的 Agent 持续 Ping；保存历史样本，显示延迟、抖动和丢包率
- SSH 工作区：机器专属快捷指令、SFTP 目录浏览/上传/下载、配置文件编辑、主机指纹校验
- AI 工作区：自定义 Chat Completions / Responses 接口、模型和推理级别；生成文件差异与命令建议，经审批后应用
- 备份与恢复（后台）：
  - 下载 SQLite 备份（支持 `.sqlite.gz` 压缩）
  - 上传备份恢复（支持 `.sqlite` / `.sqlite.gz`），恢复后自动重启
  - 恢复前会校验备份库结构与用户表，避免误恢复空库

**公开页面（无需登录）**

- `/`：公开状态页（分组 + 卡片/列表 + 详情展开）
- `/m/:id`：公开详情页（指标、网速、本月流量等）
- `/app/bastion`：SSH 堡垒机入口（需要管理员登录）
- `/app/ping`：IP/域名延迟监控（需要管理员登录）
- 公开页默认不展示主机名/系统版本/CPU 型号等敏感信息

**探针（Agent）**

- Golang，Linux 优先（静态编译，体积小）
- WebSocket 连接主控：`/ws/agent`
- 上报：
  - 指标：CPU/内存/磁盘、load(1/5/15)、网络 RX/TX（累计）
  - 系统信息：hostname、OS/Kernel、CPU 型号/核心数、架构（后台详情页可见）
- 支持 `-version` 输出版本号（用于一键脚本判断是否最新）

## 目录结构

- `server/`：Node.js 后端（REST API + WS + SQLite）
- `web/`：React 前端（Vite）
- `agent/`：Golang 探针

## 路由与端口

- HTTP：默认 `3001`
- WebSocket：
  - UI：`/ws/ui?token=<jwt>`
  - Agent：`/ws/agent`
- 生产环境：后端会托管 `web/dist` 静态资源，同域访问（推荐用 Nginx 做 TLS 反代）

## 快速开始（Docker 推荐）

1) 创建 Docker 环境变量文件，并为下面两项分别生成随机密钥

- `JWT_SECRET`
- `AGENT_KEY_SECRET`

```bash
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
```

将两次输出分别填入 `.env`。部署后不要直接更换 `AGENT_KEY_SECRET`。

从旧版本轮换密钥时，把新值写入 `AGENT_KEY_SECRET`，旧值临时写入 `AGENT_KEY_SECRET_PREVIOUS`。启动日志显示 `skipped 0` 后即可删除 `AGENT_KEY_SECRET_PREVIOUS`；程序会自动重加密探针、SSH 与 Telegram 凭据。

2) 启动

```bash
docker compose up -d --build
```

3) 初始化管理员（首次）

```bash
curl -X POST http://localhost:3001/api/auth/bootstrap \
  -H 'content-type: application/json' \
  -H "x-bootstrap-token: $BOOTSTRAP_TOKEN" \
  -d '{"username":"admin","password":"admin123"}'
```

4) 访问

- 公共状态页：`http://localhost:3001/`
- 后台登录：`http://localhost:3001/login`

数据默认挂载到宿主机 `./data/`（SQLite 文件），升级/重启不会丢数据。

## 机器出口监控与远程工作区

- 主控与 Agent 都需要升级到 v0.2.0。旧 Agent 会显示“请升级被控端”；系统不会退回主控 Ping。
- 在“机器出口延迟”选择来源机器（名称/IP/ID），目标默认 `google.com`，也可填写固定 IP。Agent 必须安装系统 `ping`（Debian/Ubuntu: `apt install iputils-ping`；Alpine: `apk add iputils`）。结果表示 ICMP RTT，不包含 HTTPS 请求耗时。
- 来源机器直接从后台已有服务器中选择，支持名称/IP/分组/ID 搜索，不依赖 SSH 配置；列表显示 Agent 在线与版本能力，支持刷新和加载失败重试。机器详情的“出口监控”可直接预选该机器。
- 曲线支持 5 分钟、15 分钟、1 小时、6 小时、24 小时范围，鼠标悬浮/触屏/方向键可查看采样详情。长时间范围聚合为最多约 240 个点，保留最小/最大延迟区间；统计值使用完整时间段样本。Agent 离线、版本不支持等归为“未探测”，不计入丢包率。
- v0.1.3 的旧主控监控将保留历史并暂停；请删除旧项后，按机器重新添加，避免混合不同来源的数据。
- 每台机器进入 SSH 工作区前须核对并保存 SSH 主机指纹。可在服务器运行 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256`（以服务端实际使用的主机密钥为准）。连接地址或指纹变化后需重新核实。
- “快捷指令”按机器保存；可插入终端或确认后执行。“文件”通过同一 SSH 用户的 SFTP 权限访问，识别 Nginx、Apache、Caddy、Docker、宝塔、1Panel 等常见目录，同时支持手动路径。
- 文本编辑限制为 UTF-8、512 KiB；上传/下载限制为 8 MiB。上传不覆盖已有文件。保存会检查内容版本、保留原权限和所有者、生成 `.yaws-backup-*`，OpenSSH 使用原子替换；不支持扩展的 SFTP 使用保留原文件的回滚替换。ACL/xattr 不通过 SFTP 复制，特殊文件和二进制文件不支持在线编辑。
- AI 设置支持完整接口地址或 `/v1` 基地址、模型、可选推理级别；`high`、`max` 等按提供方原样发送，具体支持范围由模型接口决定。模型必须支持工具调用。Responses 使用 `reasoning.effort`，Chat 使用 `reasoning_effort`。
- AI 只读取选定目录中的文件并生成建议，文件内容会发送到配置的模型接口。常见凭据路径会被拒绝，但配置文件仍可能包含敏感值；请选择适合发送的目录。AI 的文件修改和命令逐项审批，命令使用 SSH 用户权限运行，不是容器沙箱。
- AI 密钥、任务和修改内容加密存储；改变 API 域名不会复用之前域名的密钥。默认仅允许公共 HTTPS 接口，自建内网接口需显式开启“允许内网 / HTTP 接口”。
- 生产环境首次初始化需在 `.env` 设置随机 `BOOTSTRAP_TOKEN`（至少 16 字符），并在请求头传入；已有管理员不受影响。改密后旧令牌及现有 WebSocket 会话立即失效。

## 验证

```bash
npm ci
npm run build
npm test
npm run test:browser  # 默认使用已安装的 Edge；可通过 PLAYWRIGHT_CHANNEL 改用 chrome
cd agent && go test ./... && go vet ./...
```

浏览器测试使用内存数据库、SSH/SFTP 测试服务和模拟模型接口，不连接生产服务器。发布工作流运行后端/Agent 测试并生成 Linux amd64/arm64 产物及 SHA256 校验文件。

## 反向代理（Nginx，HTTPS + WebSocket + 大文件上传）

恢复备份时会上传大文件，`client_max_body_size` 必须配置在 **443 的 server 块**（HTTPS 生效的那段），否则会 413。

示例（仅示意关键点）：

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

upstream yaws_backend { server 127.0.0.1:3001; keepalive 32; }

server {
  listen 443 ssl http2;
  server_name example.com;
  # ssl_certificate /path/fullchain.cer;
  # ssl_certificate_key /path/example.com.key;

  client_max_body_size 2048m;

  location ^~ /ws/ {
    proxy_pass http://yaws_backend;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }

  location / {
    proxy_pass http://yaws_backend;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

## 探针运行（推荐两种方式）

### 方式 A：下载配置文件运行

后台机器详情页下载 `yaws-agent-<id>.json`，在被控机运行：

```bash
./yaws-agent -config yaws-agent-<id>.json
```

### 方式 B：一键安装脚本（推荐）

后台机器详情页点击“生成一键安装脚本”，复制到被控端 root 执行即可：

- 自动识别 `linux/amd64` 或 `linux/arm64`
- 从 GitHub Releases 下载 `yaws-agent-linux-amd64` / `yaws-agent-linux-arm64`
- 写入 `/etc/yaws-agent.json` 并安装 systemd 服务（无 systemd 则 fallback 后台运行）
- 自动检测是否最新版本；不最新则自动更新（`--check` 只检查，`--force` 强制重装）

## 备份与恢复

后台：`/app/settings` → “备份与恢复”

- 下载备份：建议勾选压缩（`.sqlite.gz`），体积更小，不容易触发反代/平台的上传限制
- 恢复备份：上传 `.sqlite` 或 `.sqlite.gz`，服务会自动重启；恢复期间其它接口会返回 `503 restarting`

如果你使用了 Cloudflare 之类的代理，请注意其上传大小限制（常见 100MB），优先使用 `.sqlite.gz` 或临时切灰云。

## 数据与磁盘占用

- 指标数据会持续写入 SQLite（`metrics` 表），默认保留 `30` 天并自动清理（见 `METRICS_RETENTION_DAYS`）
- 每月流量统计写入 `traffic_monthly`（按月汇总，体积很小）

## GitHub Releases（探针发布）

本仓库包含 GitHub Actions：推送 `v*` tag 会自动构建并上传探针二进制到 Release（见 `.github/workflows/release-agent.yml`）。

```bash
git tag v0.1.2
git push origin v0.1.2
```

## 开发（本地）

需要 Node.js 22 或更高版本。Linux 裸机还需 GLIBC 2.38+；较旧发行版请使用项目提供的 Docker 镜像。

```bash
npm install
npm run dev
```

默认：

- Web 开发端口：`http://localhost:5173`
- API/WS：`http://localhost:3001`

## 环境变量（后端）

见 `server/.env.example`，常用项：

- `PORT`：HTTP 端口（默认 `3001`）
- `DATABASE_PATH`：SQLite 路径（Docker 推荐用 `../data/yaws.sqlite` 或容器内绝对路径 `/app/data/yaws.sqlite`）
- `JWT_SECRET`：JWT 密钥（至少 16 字符）
- `AGENT_KEY_SECRET`：用于加密保存 agentKey（可选但强烈建议，至少 16 字符）
- `AGENT_KEY_SECRET_PREVIOUS`：仅在轮换加密密钥时临时填写旧值
- `CORS_ORIGIN`：开发时跨域来源；生产同域可不需要
- `METRICS_RETENTION_DAYS`：指标保留天数（默认 30）
- `METRICS_PRUNE_INTERVAL_MIN`：清理频率（默认 10 分钟）
- `ADMIN_RESTORE_MAX_MB`：后台“恢复备份”上传上限（MB，默认 2048）
- `TELEGRAM_BOT_TOKEN`：Telegram Bot Token（可选，也可在后台设置里配置）
- `TELEGRAM_CHAT_ID`：接收消息的 chat_id（可选，也可在后台设置里配置）
- `AGENT_GITHUB_REPO`：GitHub 仓库（例如 `yamatu/yaws`）
- `AGENT_RELEASE_BASE_URL`：Release 下载前缀（可选，默认 `releases/latest/download`）

## Telegram 通知配置

后台：`/app/settings` → “Telegram 通知”

1) 创建 Bot：在 Telegram 搜索 `@BotFather` → `/newbot` 获取 `Bot Token`
2) 获取 `chat_id`：
   - 私聊：给 bot 发一条消息，然后访问 `https://api.telegram.org/bot<token>/getUpdates`，在返回里找到 `chat.id`
   - 群聊：把 bot 拉进群并发消息，同样用 `getUpdates` 获取（群聊 chat_id 通常是负数）
3) 配置并点击“发送测试”

离线判定默认 5 分钟：如果机器 `last_seen_at` 超过该时间未更新，则认为离线并通知。

### 常见问题（Telegram）

- `telegram_unauthorized`：Bot Token 错误（401），检查 token 是否粘贴完整、是否使用了正确的 bot。
- `telegram_cant_initiate` / `telegram_forbidden`：私聊场景下，Bot 不能主动给你发消息。请先在 Telegram 打开 Bot 并发送一次 `/start`。
- `telegram_not_in_chat`：群/频道场景下，Bot 不在该群/频道或无权限。把 Bot 拉进群/频道并授予发言权限，再测试。
- `telegram_blocked`：你屏蔽了 Bot，解除屏蔽并重新发送 `/start`。

## 排错速查

- `413 Content Too Large`：检查 Nginx 的 `client_max_body_size` 是否配置在 **443 server**；或平台/代理限制（优先用 `.sqlite.gz`）。
- `cannot execute binary file: Exec format error`：探针架构不匹配（amd64/arm64），用一键脚本会自动选择正确架构。
- 恢复后页面空：容器未重启/仍读旧库时，重启容器即可；日志会打印 `[db] ... users=... machines=... metrics=...` 便于确认。
- Telegram 测试 `403`：通常是没 `/start`、chat_id 不对、或 bot 不在群里（后台会显示更具体的错误提示）。
