# YAWS (Yet Another Watchdog System)

轻量级的“主控 + 被控探针”监控系统（Node.js + React + SQLite + WebSocket + Go Agent），支持公开状态页与后台管理。

## 主要特性

**主控（Web）**

- 账号密码登录；后台可修改用户名/密码
- 机器管理：新增/编辑/删除；自定义分组（地区/云厂商/用途…）
- 多视图：卡片/列表；列表支持点击展开详情
- 占用条按负载变色：CPU/内存/磁盘低于 75% 为绿色、75% 起转黄、90% 起转红（无数据为灰色），进度条和百分比数字同步变色；进度条为毛玻璃质感，高负载时轨道会淡淡泛红，`prefers-reduced-motion` 下不做呼吸动画
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
- AI 助手：聊天式运维助手，可悬浮在终端/编辑器之上（面板可自由拖动、缩放）；回答按 Markdown 渲染（标题/列表/表格/代码块带复制按钮，不执行 HTML）；可保存多套 Chat Completions / Responses 接口、模型和推理级别并随时切换，助手自行读取文件、日志与资源占用，只读命令直接执行，修改类命令和文件写入生成审批卡片，危险命令一律先确认，写入可一键还原
- 证书自动管理：通过机器 SSH 扫描常见证书目录，识别域名/到期时间；支持 Cloudflare DNS 申请 Let’s Encrypt 证书、备份回滚、`nginx -t` 校验及 Nginx reload
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
- “快捷指令”按机器保存，默认折叠，点击标题展开已保存的命令（徽标显示条数，折叠状态在浏览器中记住）；可插入终端或确认后执行。“文件”通过同一 SSH 用户的 SFTP 权限访问，识别 Nginx、Apache、Caddy、Docker、宝塔、1Panel 等常见目录，同时支持手动路径。
- 文件编辑器带语法高亮：优先按文件名/扩展名匹配（JSON/YAML/Shell/Nginx/Dockerfile/服务单元/`.env`/点文件等），无扩展名时再按 `#!` 识别解释器，工具栏右侧会显示当前语言；未知类型按纯文本处理，超过 400 KiB 的文件自动关闭高亮以保持流畅。
- 在“文件”或“AI”标签页时 SSH 终端会固定显示在右侧（窄屏时改为底部），可直接在编辑器旁执行命令；两个面板之间的分隔条可拖动调整比例（方向键微调、`Shift`/`PageUp`/`PageDown` 大步、`Home`/`End` 到两端、双击恢复默认），比例记在浏览器中；标签栏右侧的按钮可随时收起/展开终端面板。
- 触屏设备上终端默认显示按键栏（Esc/Tab/方向键/^C 等控制键、常用符号、粘贴、回车），Ctrl/Alt 为粘滞修饰键；按键栏可通过标签栏的键盘按钮隐藏，选择会记在浏览器中。
- “AI 助手”既是工作区的聊天标签页，也是可悬浮在终端、文件等任何标签页之上的附加面板（右下角按钮展开/收起）。悬浮面板可拖动标题栏移动到任意位置，右下角可调整大小，位置和尺寸记在浏览器中（双击标题栏回到默认右下角），拖动/缩放始终限制在可视区域内，手机上也不会盖住触屏按键栏。气泡、工具卡片和审批卡片各自排列并独立滚动（命令输出、日志、diff 在卡片内滚动），互不挤压；面板过小时设置表单会改为覆盖聊天区，保证消息区始终可用。对话按机器保存，可继续提问或删除。助手的回答按 Markdown 渲染：标题、列表（含任务清单）、引用、表格、`行内代码`、代码块（带语言标签和一键复制）、加粗/斜体/删除线、链接（新标签页打开，`rel="noreferrer noopener"`）；不解析也不执行任何 HTML（助手回答和它读到的文件内容都只当文本显示），远程图片不会自动加载（只显示为链接）。
- 工作区侧边栏的“快捷指令”下方显示该机器的服务器占用：CPU（两次 `/proc/stat` 采样，取不到时退回开机以来平均值）、内存/Swap（按 `MemAvailable` 计算）、各挂载点磁盘用量、占用最高的进程和网卡收发总量，主机指纹确认后每 15 秒自动刷新（页面切到后台时暂停，可手动暂停/刷新）。数据由主控通过 SSH 直接读取 `/proc`，不需要 Agent，也不需要 Node/Go 运行环境；快照缓存 5 秒并合并并发请求，同一机器同一时刻只探测一次。进程列表依赖 `procps`（Debian/Ubuntu: `apt install procps`；Alpine 的 busybox `ps` 不含 CPU 占用，此时只显示其他指标），容器文件绑定挂载（`/etc/hosts`、`/config` 等）会自动去重。各项占用条与主页使用同一套配色（绿/黄/红 + 毛玻璃），百分比数字同步变色。
- 文本编辑限制为 UTF-8、512 KiB；上传/下载限制为 8 MiB。上传不覆盖已有文件。保存会检查内容版本、保留原权限和所有者、生成 `.yaws-backup-*` 回滚副本（同一文件只保留最近 3 份，旧的自动清理），OpenSSH 使用原子替换；不支持扩展的 SFTP 使用保留原文件的回滚替换。ACL/xattr 不通过 SFTP 复制，特殊文件和二进制文件不支持在线编辑。
- AI 设置支持多个模型配置（最多 20 个）：可新建、复制、删除并随时在对话框顶部切换当前使用的配置（配置随账号保存在主控，浏览器也记住最近选择）；每个配置有自己的接口地址、模型、协议、推理级别、API Key 和“允许内网”开关，密钥不会回传给浏览器（留空表示不修改，可显式清除），复制配置需要重新填写密钥。接口地址支持完整路径或 `/v1` 基地址；`high`、`max` 等推理级别按提供方原样发送，具体支持范围由模型接口决定。模型必须支持工具调用。Responses 使用 `reasoning.effort`，Chat 使用 `reasoning_effort`。
- 对话选择器支持按标题、目录、模型、内容搜索，按“今天/昨天/最近 7 天/更早”分组，显示轮数、使用的模型和最后一条消息摘要，可直接重命名（也可删除）历史对话；键盘 `↑`/`↓` 选择、`Enter` 进入、`Esc` 关闭。
- 助手可使用 `list_files`、`read_file`、`read_log`、`run_command`、`server_stats`、`write_file` 六类工具。命令分为“只读/修改/危险”三级：只读命令（`df`、`journalctl`、`docker ps`、`nginx -t` 等）可直接执行；“修改类命令也自动执行”开启后 `systemctl restart`、`apt install` 等无需逐条确认；`rm -rf`、`mkfs`、改密码、`chmod -R` 等危险命令永远需要人工确认。默认策略是“只读命令自动执行”。
- AI 只读取选定工作目录中的文件，目录外的路径会被拒绝；读取到的文件、日志和命令输出会发送到配置的模型接口。`.ssh`、`.aws`、`.env`、`*.pem/*.key`、`shadow` 等凭据路径一律拒绝读取，但普通配置文件仍可能包含敏感值，请选择适合发送的目录。
- 执行方式可在对话框底部切换（只读自动执行 / 修改类也自动执行 / 每条都确认），开启自动执行时助手写入文件仍会生成 `.yaws-backup-*` 回滚副本，并可在对话里点“撤销”还原。命令使用 SSH 用户权限运行，不是容器沙箱；助手会把远程内容当作数据而不是指令，但请仍然人工审阅待确认操作。
- AI 密钥、任务和修改内容加密存储；改变 API 域名不会复用之前域名的密钥（旧版单配置接口 `PUT /api/ai/settings` 仍可用，它会更新当前配置并复用已保存的密钥）。默认仅允许公共 HTTPS 接口，自建内网接口需显式开启“允许内网 / HTTP 接口”。
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
    # Required: without these the backend only sees the proxy address, so every
    # login attempt shares one rate-limit budget (login lockout) and the log has
    # no real client IP. Keep TRUST_PROXY=1 in .env to match this single hop.
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }

  location / {
    proxy_pass http://yaws_backend;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
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

## 安全基线

代码层面已经内置以下防护，运维时请一并确认：

- **请求头**：所有响应都带 `Content-Security-Policy`（无内联脚本/外部资源，`connect-src` 仅本方同源 + `ws(s)`）、`X-Content-Type-Options`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`Permissions-Policy`、`Cross-Origin-Opener-Policy`；当 `X-Forwarded-Proto: https` 时附加 HSTS。若要新增 CDN/外链等资源，必须同步放宽 CSP，否则会被浏览器拦截。
- **登录**：生产环境必须显式提供 `BOOTSTRAP_TOKEN` 才能初始化管理员；密码校验（bcrypt）并发上限 4、排队上限 64、排队超时 10 秒，超过则返回 429（不会把管理员永久锁在门外）；同一 IP 10 分钟内失败 20 次会短暂 429。请务必按上面的 Nginx 配置传递 `X-Forwarded-For`，否则所有客户端会被算作同一个 IP。
- **授权**：`/api/machines/:id/workspace`（远程文件/终端）与其它 `/api/machines` 路由都显式要求 `requireAuth + requireAdmin`；WebSocket（`/ws/ui`、`/ws/ssh`）在升级前校验 Origin、JWT 和角色，探针连接必须通过机器密钥校验。
- **密钥强度**：生产环境 `JWT_SECRET`、`AGENT_KEY_SECRET` 少于 32 字符直接拒绝启动；数据库中保存的凭据（探针密钥、SSH 密码/私钥、Telegram、Cloudflare Token）都用 AES-256-GCM 加密存放，并校验密文结构。
- **命令执行**：探针安装脚本会用单引号包裹所有外部参数（仓库、镜像地址），配置写入使用带引号的 heredoc，SQL 全部使用参数化语句，SSRF/命令注入白名单在 AI 与 Ping 模块中生效。
- **AI 助手**：远程编辑会在目标文件旁生成 `.yaws-backup-<时间戳>-<随机>` 回滚副本，只保留最近 3 份；助手写入（含自动执行）后可一键还原，还原同样校验文件版本，避免覆盖他人改动。助手调用工具的次数、上下文大小和并发均有上限，`rm -rf`、`mkfs`、`shred`、改密码、`curl | sh` 等危险模式即使开启自动执行也强制走人工确认。
- **回答渲染**：Markdown 由 `web/src/ui/markdown.ts` 解析成数据结构后交给 React 渲染，全程不使用 `dangerouslySetInnerHTML`/`innerHTML`，因此模型或文件内容里的 `<script>`、`onerror=` 只会以纯文本显示；链接仅允许 `http(s)`/`mailto`（`javascript:`、`data:`、`file:` 一律按文本处理），接口地址以外的外链均由浏览器直接访问，主控不代理。
- **数据库**：WAL 模式 + `busy_timeout`，并设置 16 MiB 页缓存与预编译语句缓存以提升高并发写入（指标/流量）性能，语句缓存按连接复用。

本地开发时请不要把 `.env`、`data/` 或备份文件提交到 Git。

## 环境变量（后端）

见 `server/.env.example`，常用项：

- `PORT`：HTTP 端口（默认 `3001`）
- `DATABASE_PATH`：SQLite 路径（Docker 推荐用 `../data/yaws.sqlite` 或容器内绝对路径 `/app/data/yaws.sqlite`）
- `JWT_SECRET`：JWT 密钥（**生产环境至少 32 字符**，用 `openssl rand -hex 32` 生成，否则启动会报错）
- `AGENT_KEY_SECRET`：用于加密保存 agentKey（可选但强烈建议，生产环境至少 32 字符）
- `AGENT_KEY_SECRET_PREVIOUS`：仅在轮换加密密钥时临时填写旧值
- `TRUST_PROXY`：反代层数（默认 `1`，对应上面的 Nginx 单层反代；端口直接暴露给公网时设为 `0`）。它决定 `X-Forwarded-For` 是否可信，因此也决定登录失败限流按哪个 IP 计数
- `CORS_ORIGIN`：跨域来源，留空即关闭（生产默认关闭，仪表盘同域访问不需要；开发环境自动使用 `http://localhost:5173`）
- `METRICS_RETENTION_DAYS`：指标保留天数（默认 30）
- `METRICS_PRUNE_INTERVAL_MIN`：清理频率（默认 10 分钟）
- `ADMIN_RESTORE_MAX_MB`：后台“恢复备份”上传上限（MB，默认 2048）
- `TELEGRAM_BOT_TOKEN`：Telegram Bot Token（可选，也可在后台设置里配置）
- `TELEGRAM_CHAT_ID`：接收消息的 chat_id（可选，也可在后台设置里配置）
- `AGENT_GITHUB_REPO`：GitHub 仓库（例如 `yamatu/yaws`）
- `AGENT_RELEASE_BASE_URL`：Release 下载前缀（可选，默认 `releases/latest/download`）
- `CERT_EMAIL`：ACME 注册邮箱，默认 `yamatu@qq.com`
- `CF_Token` / `CF_Account_ID`：Cloudflare DNS API 凭据（也可以在后台“证书管理”中配置；数据库配置会加密保存）
- `CF_Key` / `CF_Email`：旧的 Global API Key 方式（可选，与 `CF_Token` 二选一）
- `CERT_CA_SERVER`：传给 `acme.sh --server` 的签发机构，默认 `letsencrypt`（acme.sh 3.x 自带默认是 ZeroSSL，会额外要求 EAB 注册，因此这里显式指定）
- `CERT_USE_SERVER_CREDS`：设为 `server` 时完全不向远程传 `CF_*`，由服务器上 acme.sh 自己的 `~/.acme.sh/account.conf` 提供凭据

## 证书自动管理

登录后台后打开“证书管理”：

1. 配置 `CF_Token`（建议）或 `CF_Key` + `CF_Email`，注册邮箱默认 `yamatu@qq.com`。API Token 只需要对应 Zone 的 `DNS:Edit` 权限。若你一直是用 `./acme.sh --issue --dns dns_cf -d 域名` 手动续期的，勾选“使用服务器上 acme.sh 已保存的凭据”，程序就不会传 `CF_*`，完全等同于手动命令的行为。
2. 页面会直接列出所有已配置 SSH 的机器，可以单台扫描，也可以点“扫描全部”批量扫描。只有已完成 SSH 主机指纹信任的机器可以扫描。
3. 扫描时先执行 `nginx -T` 读取正在生效的 `ssl_certificate` / `ssl_certificate_key` 指令，因此宝塔等面板写入自定义路径的证书也能被发现；同时会搜索 Nginx、Let’s Encrypt、Apache、OpenSSL、宝塔/1Panel、`/etc/pki`、`/root/.acme.sh` 等常见目录。SSH 用户不是 root 时会自动尝试免密 `sudo -n`。
4. 证书域名优先取 SAN，没有 SAN 时回退到证书 CN；匹配的私钥按同目录 `privkey.pem` / `key.pem`、带版本号的 `privkeyN.pem`（Let's Encrypt 的 `archive/fullchain1.pem` == `privkey1.pem`）、同名 `.key` / `.pem` 顺序查找，并排除“把证书本身当成私钥”的情况。同一张证书常能通过多个路径访问（`live/fullchain.pem`、`archive/fullchain1.pem`、面板里的副本），扫描会用 SHA-256 指纹合并为一条记录，并保留有私钥、且不在 `archive/` 下的那个路径，避免同一证书出现两条记录或续期按钮变灰。扫描结果会显示候选文件数、可解析证书数、未配对私钥数、openssl 与 nginx 是否存在，便于排查权限问题。
5. 点击证书对应的“申请/更新”前，服务器需要安装 `acme.sh`（`PATH`、`~/.acme.sh/acme.sh`、`/root/.acme.sh/acme.sh` 任一位置），且 SSH 用户需要能够执行 `nginx -t` 并 reload Nginx。非 root 用户在有免密 sudo 时会通过 `sudo -n` 执行。更新会先备份当前证书/私钥，申请成功后执行 `nginx -t`，校验失败自动恢复备份，并回写新的到期时间。
6. 开启“到期前自动续期”后，主控每 6 小时检查一次，默认在到期前 30 天处理。只处理扫描到且存在私钥路径的证书；因进程重启而中断的续期会在下次启动时恢复为可重试状态。
7. 没有可扫描到的证书时，可以在“手动申请证书”里直接输入域名（每行一个，也可用空格/逗号分隔，支持 `*.example.com` 通配符），选择服务器后点“申请证书”。系统会执行 `acme.sh --issue --dns dns_cf -d ...` 申请，并把 `fullchain` / `key` 安装到你指定（或默认 `/etc/nginx/ssl/<域名>.pem|.key`）的路径，签发完成后重新读取证书真实域名与到期时间写入清单，因此手动申请的证书同样会被自动续期。已扫描到的同域名证书路径会被自动沿用。
8. 手动申请默认勾选“强制重新签发（--force）”和“校验 Nginx 配置并重载”。同一域名重复申请会触发 Let’s Encrypt 速率限制（每周 5 次），仅需安装到新路径时可取消强制签发。若 Nginx 站点尚未指向新路径，签发成功后会给出提醒——程序不会自动改写站点配置。

申请/续期失败会返回 acme.sh 的**真实原因**：命令带 `--debug 2` 执行，因此 `dns_cf` 会把 Cloudflare API 的返回（如 `{"code":9109,"message":"Invalid access token"}`）打进输出，程序只保留 `Error add txt for domain:...`、`response=...` 这类关键行，去掉 “Please add '--debug'” 之类的无用提示，并在写回错误信息前把 `CF_Token` / `CF_Key` 全部替换成 `***`。所以页面括号里的内容可以直接照抄到手动命令里复现。

DNS 验证失败（`acme_issue_failed`）常见原因：

- 目标域名的 Zone 不在当前 Token 所属账号下，或 Token 只授权了别的域名。Token 需要在**目标域名所在 Zone** 上拥有 `DNS:Edit`。
- 误把 Global API Key（37 位十六进制）填进了 `CF_Token`：Cloudflare 会返回 `9109 Invalid access token`。请改填到 `CF_Key` 并补上 `CF_Email`。
- 手动 `./acme.sh` 能成功而本程序失败：说明凭据来源不同。手动命令读取的是 `~/.acme.sh/account.conf`，本程序默认传后台保存的 `CF_Token`（环境变量优先于 account.conf）。此时勾选“使用服务器上 acme.sh 已保存的凭据”即可。
- 解析商不是 Cloudflare，或域名有多级子域需要 `_acme-challenge` CNAME 委派。

清理不需要的证书记录：证书清单每行右侧的“删除”会把该条记录从主控清单移除；清单上方还有“清理已到期（N）”“清理异常（N）”两个批量按钮，只作用于当前选中的服务器。删除**只移除主控记录，不会删除服务器上的证书文件，也不会执行任何远程命令**；被删除的证书不再参与自动续期，如果文件仍存在于服务器上，下次扫描会重新发现并重新加入清单。因此想彻底停止续期某个证书时，应先在服务器上删除/停用对应站点，再做清理。

远程脚本兼容性：续期/申请脚本会被登录 shell 解析，Debian/Ubuntu（`dash`）与 Alpine（`busybox ash`）不支持 bash 专用的 `trap ... ERR`，所以脚本不再依赖 ERR trap，而是每一步用 `|| fail <code>` 自行处理并在失败时调用 `restore` 回滚备份；`acme.sh` 的 `--install-cert` 会先按默认方式尝试，失败后用 `--ecc` 重试，以兼容 ECC/RSA 两种证书目录。

错误码与常见原因：

- 机器列表会直接标出 SSH 凭据状态。出现“SSH 密码/私钥无法解密”说明 `AGENT_KEY_SECRET`（未设置时回退到 `JWT_SECRET`）与保存密码时不一致，扫描必然失败。
- 修复方式二选一：到机器详情重新保存一次 SSH 密码/私钥；或把旧密钥配到 `AGENT_KEY_SECRET_PREVIOUS` 后重启一次，程序会自动把旧的密文重新加密成新密钥（`ssh_password_enc`、`ssh_key_enc`、`agent_key_enc` 都支持轮换）。
- `ssh_auth_failed`：用户名或密码/私钥不正确（密码能解密但服务器拒绝登录）。
- `ssh_host_untrusted` / `ssh_host_key_changed`：需要先在机器详情完成或重新做指纹信任。
- `ssh_exec_failed`：该账户不允许远程命令（可能被限制为仅 SFTP），或连接在握手后立即断开。
- `certificate_scan_failed` / `certificate_renew_failed` / `certificate_issue_failed`：括号内是远程命令的关键报错行（已截断为前后各一段，不会再从中间截断），可直接用来定位。
- `acme_issue_failed`：DNS-01 验证未通过。括号里会带上 Cloudflare API 的原始返回，例如 `9109 Invalid access token`（Token 无效或权限不足）、`record already exists`、`81044`（记录已存在）等。
- `acme_install_failed`：证书已签发但写入目标路径失败，通常是 SSH 用户既不是 root 也无法免密 `sudo -n`；`cert_dir_failed` / `backup_failed` 同理。
- `nginx_config_test_failed`：`nginx -t` 未通过，此时已自动回滚到原证书，请先修复配置。
- `bad_domain` / `bad_cert_path` / `bad_key_path` / `cert_and_key_same_path`：请求参数校验失败，不会执行任何远程命令。
- `certificate_internal_error`：本应不会出现；如果看到请把括号内容反馈，服务端日志同时会打印 `[certificates] ...` 的完整堆栈。

环境变量示例：

```dotenv
CERT_EMAIL=yamatu@qq.com
CF_Token=your-cloudflare-api-token
CF_Account_ID=your-cloudflare-account-id
# 可选：旧的 Global API Key 方式
CF_Key=
CF_Email=
CERT_CA_SERVER=letsencrypt
# 可选：改为使用服务器上 acme.sh 已保存的凭据
CERT_USE_SERVER_CREDS=
```

Cloudflare API Token 至少需要对应 Zone 的 `DNS:Edit` 权限。不要把真实 Token 提交到 Git；后台保存的 Token 使用 `AGENT_KEY_SECRET` 加密。

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
