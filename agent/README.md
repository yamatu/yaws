# YAWS Agent

被控端探针（优先支持 Linux）。通过 WebSocket 连接主控并周期上报：

- 系统信息：系统类型/版本、内核版本、架构、CPU 型号、核心数、hostname
- 指标：
  - CPU 使用率
  - 内存使用量
  - 磁盘使用量（默认根目录 `/`）
  - load(1/5/15)
  - 网络流量（累计 RX/TX，来自 `/proc/net/dev`，排除 lo）

## 编译

```bash
go build -ldflags="-s -w" -o bin/yaws-agent ./cmd/yaws-agent
```

也可以用 Makefile 一键编译不同平台：

```bash
make linux-amd64
make linux-arm64
```

## 运行

```bash
./bin/yaws-agent -url ws://<主控IP>:3001/ws/agent -id <machineId> -key <agentKey>
```

推荐：从主控后台下载配置文件（`yaws-agent-<id>.json`）后直接运行：

```bash
./bin/yaws-agent -config yaws-agent-<id>.json
```

## 一键安装（推荐）

在主控后台机器详情页生成“一键安装脚本”，复制到被控端 root 执行即可：

- 自动识别 `linux/amd64` 与 `linux/arm64`
- 从 GitHub Releases 下载 `yaws-agent-linux-amd64` / `yaws-agent-linux-arm64`
- 写入 `/etc/yaws-agent.json` 并注册 systemd 服务
