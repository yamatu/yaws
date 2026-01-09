# YAWS Agent

被控端探针（优先支持 Linux）。通过 WebSocket 连接主控并周期上报：

- CPU 使用率
- 内存使用量
- 磁盘使用量（默认根目录 `/`）

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
