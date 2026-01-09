# YAWS (Yet Another Watchdog System)

一个从零开始的轻量级“主控 + 被控探针”监控系统：

- 前端：React（Vite）登录后查看机器状态/指标、配置机器
- 后端：Node.js（Express）+ SQLite，提供 REST API + WebSocket
- 探针：Golang（Linux 优先）通过 WebSocket 上报 CPU/内存/磁盘

## 目录结构

- `server/`：Node.js 后端（API + WS + SQLite）
- `web/`：React 前端
- `agent/`：Golang 探针

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

## 运行探针（Linux）

在后台新增机器后，在机器详情页下载 `yaws-agent-<id>.json`，然后在被控机上运行：

```bash
cd agent
go build -ldflags="-s -w" -o bin/yaws-agent ./cmd/yaws-agent
./bin/yaws-agent -config yaws-agent-<id>.json
```

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

## GitHub + 一键安装（探针）

- 探针一键安装脚本会从 `AGENT_GITHUB_REPO` 的 GitHub Releases 下载对应架构二进制（`yaws-agent-linux-amd64` / `yaws-agent-linux-arm64`）。
- 本仓库已包含 GitHub Actions：推送 tag（例如 `v0.1.0`）会自动构建并把探针二进制上传到 release 资源中（见 `.github/workflows/release-agent.yml`）。
