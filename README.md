# YAWS (Yet Another Watchdog System)

一个从零开始的轻量级“主控 + 被控探针”监控系统：

- 前端：React（Vite）支持后台/公开页、卡片/列表、多分组
- 后端：Node.js（Express）+ SQLite，提供 REST API + WebSocket
- 探针：Golang（Linux 优先）通过 WebSocket 上报指标 + 系统信息

## 功能概览

- 登录后台：账号密码登录；支持在后台修改用户名/密码
- 机器管理：新增/编辑/删除；支持自定义分组（例如地区/云厂商）
- 排序与视图：
  - 后台总览支持卡片/列表切换
  - 列表模式支持拖拽排序并保存（自定义顺序）
  - 支持按到期剩余天数升序排序（便于到期巡检）
- 监控指标（实时/历史）：
  - CPU/内存/磁盘（/）
  - load(1/5/15)
  - 网络流量（累计 RX/TX）与网速（按采样差值计算）
- 服务器到期管理（站内展示）：到期时间、购买金额、计费周期（月/季/半年/年/两年/三年）、自动续费开关（仅展示）
- 公开页面（无需登录）：
  - `/`：公开状态页（支持分组与卡片/列表）
  - `/m/:id`：公开详情页（指标 + 系统信息）
- 探针部署：
  - 下载配置文件运行（无需复制粘贴 agentKey）
  - 生成“一键安装脚本”（root 直接执行，自动识别 Linux 架构并从 GitHub Releases 下载探针）

## 目录结构

- `server/`：Node.js 后端（API + WS + SQLite）
- `web/`：React 前端
- `agent/`：Golang 探针

## 端口与路由

- 后端 HTTP：默认 `3001`
- WebSocket：
  - UI：`/ws/ui?token=<jwt>`
  - Agent：`/ws/agent`
- 前端（开发态）：默认 `5173`（Vite）
- 生产态：后端会托管 `web/dist`，同域访问（推荐配 Nginx 做 TLS）

## 快速开始（开发）

1) 安装依赖

```bash
npm install
```

2) 可选：配置后端环境变量

复制 `server/.env.example` 为 `server/.env` 并修改 `JWT_SECRET`（至少 16 字符）。

3) 启动后端与前端

```bash
npm run dev
```

4) 初始化管理员账号（首次）

后端启动后调用：

```bash
curl -X POST http://localhost:3001/api/auth/bootstrap \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"admin123"}'
```

5) 前端访问

- `http://localhost:5173`

## 使用指南（后台）

- 后台入口：`/app`
- 账号设置：`/app/settings`（修改用户名/密码，需要输入当前密码）
- 新增机器：
  - 名称、分组（可选）、上报间隔、探针连接地址（一般是 `wss://你的域名/ws/agent`）
  - 到期日期、购买金额、计费周期（月/季/半年/年/两年/三年）、自动续费（仅展示）
- 总览：
  - 分组筛选：顶部分组按钮（全部/未分组/自定义分组）
  - 视图：卡片/列表切换
  - 排序：自定义 / 到期升序
  - 列表模式：按住左侧拖拽图标可调整顺序并保存

## 运行探针（Linux）

推荐方式：在后台机器详情页下载 `yaws-agent-<id>.json`，然后在被控机上运行：

```bash
cd agent
go build -ldflags="-s -w" -o bin/yaws-agent ./cmd/yaws-agent
./bin/yaws-agent -config yaws-agent-<id>.json
```

探针会上报：

- 系统信息：系统类型/版本、内核版本、架构、CPU 型号、核心数、hostname
- 指标：CPU/内存/磁盘、load(1/5/15)、网络流量 RX/TX（累计）

## 一键安装脚本（推荐）

后台机器详情页点击“生成一键安装脚本”，复制到被控端 root 执行即可：

- 自动识别 `linux/amd64` 或 `linux/arm64`
- 从 `https://github.com/<AGENT_GITHUB_REPO>/releases/latest/download/` 下载对应探针二进制
- 写入 `/etc/yaws-agent.json` 并安装 systemd 服务（若无 systemd 则 fallback 为后台运行）

注意：

- 需要你在 GitHub Releases 中存在 `yaws-agent-linux-amd64` / `yaws-agent-linux-arm64` 两个资源文件
- 生产环境建议配 `wss://`，并确保被控端能访问主控域名

## 生产部署（简版）

```bash
npm run build
npm run start
```

后端会在 `server/` 内启动，并在可用时托管 `web/dist` 静态资源。

## Docker 部署

1) 修改 `docker-compose.yml` 里的 `JWT_SECRET` / `AGENT_KEY_SECRET`（至少 16 字符）

可选：调整指标保留时间（默认 30 天），见 `server/.env.example` 的 `METRICS_RETENTION_DAYS`。

2) 启动

```bash
docker compose up -d --build
```

3) 初始化管理员（首次）

```bash
curl -X POST http://localhost:3001/api/auth/bootstrap \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"admin123"}'
```

4) 访问

- 公共状态页：`http://localhost:3001/`
- 后台登录：`http://localhost:3001/login`（登录后进入 `/app`）

## 反向代理（Nginx，支持 WebSocket）

如果你要用域名 + HTTPS（wss），Nginx 需要对 `/ws/` 做 WebSocket Upgrade：

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

upstream yaws_backend { server 127.0.0.1:3001; }

server {
  listen 443 ssl http2;
  server_name example.com;
  # ssl_certificate /path/fullchain.cer;
  # ssl_certificate_key /path/example.com.key;

  location ^~ /ws/ {
    proxy_pass http://yaws_backend;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
  }

  location / {
    proxy_pass http://yaws_backend;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

## GitHub + 一键安装（探针）

- 探针一键安装脚本会从 `AGENT_GITHUB_REPO` 的 GitHub Releases 下载对应架构二进制（`yaws-agent-linux-amd64` / `yaws-agent-linux-arm64`）
- 本仓库已包含 GitHub Actions：推送 tag（例如 `v0.1.0`）会自动构建并把探针二进制上传到 release 资源中（见 `.github/workflows/release-agent.yml`）

发布探针（推荐）：

```bash
git tag v0.1.0
git push origin v0.1.0
```

## 环境变量（后端）

见 `server/.env.example`，常用项：

- `PORT`：HTTP 端口（默认 `3001`）
- `DATABASE_PATH`：SQLite 路径（默认 `./data/yaws.sqlite`）
- `JWT_SECRET`：JWT 密钥（至少 16 字符）
- `AGENT_KEY_SECRET`：用于加密保存 agentKey（可选，建议设置，至少 16 字符）
- `CORS_ORIGIN`：开发时跨域来源；生产推荐同域（Nginx 反代后可不需要）
- `METRICS_RETENTION_DAYS`：指标保留天数（默认 30）
- `METRICS_PRUNE_INTERVAL_MIN`：清理频率（默认 10 分钟）
- `AGENT_GITHUB_REPO`：GitHub 仓库（例如 `yamatu/yaws`）
- `AGENT_RELEASE_BASE_URL`：Release 下载前缀（可选，默认 `releases/latest/download`）
