# YAWS (Yet Another Watchdog System)

轻量级的“主控 + 被控探针”监控系统（Node.js + React + SQLite + WebSocket + Go Agent），支持公开状态页与后台管理。

## 主要特性

**主控（Web）**

- 账号密码登录；登录状态会被缓存：勾选「记住我」（默认）时令牌写入 `localStorage`，关闭浏览器仍保持登录（7 天有效），不勾选则只存 `sessionStorage`，关掉标签页即失效；用户名会记住以便下次只输密码；每次打开页面先向服务端校验缓存登录，令牌快到期时自动续期（持续使用不会中途掉线），令牌失效/被改密码作废时自动清掉并跳回登录页提示「登录状态已过期」，登录后回到原来的页面；后台可修改用户名/密码
- 机器管理：新增/编辑/删除；自定义分组（地区/云厂商/用途…）
- 多视图：卡片/列表；列表支持点击展开详情
- 占用条按负载变色：CPU/内存/磁盘低于 50% 为绿色、50% 起转黄、70% 起转红（无数据为灰色），进度条和百分比数字同步变色；每档都是“浅 → 标准 → 深”三段渐变，颜色在进度条中间会过渡，不会一块死色；进度条为毛玻璃质感，高负载时轨道会淡淡泛红，`prefers-reduced-motion` 下不做呼吸动画
- 排序：
  - 自定义顺序（列表拖拽并保存）
  - 到期剩余天数升序
  - 仅离线机器（没有离线则显示为空）
- 指标：CPU/内存/磁盘、load(1/5/15)、流量（累计 RX/TX）、网速（按差值计算）
- 每月流量：自动按月统计 RX/TX（跨月自动归零重新统计）
- 到期信息（站内展示）：到期时间、购买金额、计费周期（月/季/半年/年/两年/三年）、自动续费开关（仅展示）
- Telegram 通知：离线/恢复在线/到期提醒（后台可配置；或使用环境变量）
- 堡垒机：登录后台后统一查看已配置 SSH 主机、进入 WebSSH，并查看/断开活动会话；SSH 会话由主控服务端代理并记录审计信息。内网机器会标出「内网 · 经由 X」，说明它是通过哪台跳板机访问的
- 延迟监控：选择来源机器和目标 IP/域名，由该机器的 Agent 持续 Ping；保存历史样本，显示延迟、抖动和丢包率
- SSH 工作区：机器专属快捷指令、SFTP 目录浏览/上传/下载、配置文件编辑、主机指纹校验；会记住上次所在的标签页（终端/文件/AI）、浏览的目录、打开的文件，以及文件里的光标行与滚动位置，下次进来（包括刷新/重开浏览器）直接回到原处继续改
- 多终端工作区：在同一个页面里并排管理多台服务器（会话条最多 32 个，够一次打开整个机群；服务端每用户 48 个 / 全局 128 个，空闲 2 小时回收）。会话条上的圆点显示每台机器的连接状态，点 `+` 可按名称/IP/分组或 ID 搜索服务器，也可以一次“打开全部可连接的服务器”把配置了 SSH 的机器全部打开（真开不完时会告诉你还剩几台，而不是默默少开）。切换会话不会断开后台终端，也不会丢失各自的终端缓冲区、文件视图和 AI 对话：每台机器一份独立的助手上下文，切回来还在原处，多台机器可以同时问（互不排队，见下文并发上限）；会话列表记在浏览器里（`yaws.ssh.sessions`），刷新后自动恢复
- AI 助手：聊天式运维助手，可悬浮在终端/编辑器之上（面板可自由拖动、缩放）；状态行会说清楚当前在做什么（第几步、正在思考 / 正在读哪个文件或跑哪条命令 / 正在整理回答 / 等待你确认几个操作）并累计用时，**只有整轮真正结束才显示“已完成”**，中断显示“已停止”、出错显示“执行失败”；回答按 Markdown 渲染（标题/列表/表格/代码块带复制按钮，不执行 HTML）；可保存多套 Chat Completions / Responses 接口、模型和推理级别并随时切换，助手自行读取文件、日志与资源占用，只读命令直接执行，修改类命令和文件写入生成审批卡片，危险命令一律先确认，写入可一键还原。回答按 token 实时流式输出（不再等整段生成完才显示）：模型的思考过程（reasoning）单独折叠展示、不会混进回答，结束后显示本轮 token 用量（输入/输出/合计），并在模型报告提示词缓存时附上「缓存命中 token 数 / 提示词 token 数」和命中率进度条；请求模型时默认开启 `stream`，遇到不支持流式或拒绝 `stream_options` 的网关会自动退回一次性 JSON 响应
- 多机 AI 助手：一轮提问可以同时带上多台服务器（对话框底部的「主机」选择器，主机器固定，另外最多再选 7 台）。只读检查（`df`、`systemctl status`、`uptime`…）可以一次在勾选的主机上并行执行（最多 4 台同时跑，逐台汇总结果），每张工具卡片和审批卡片都标注是在哪台主机上执行的；修改类操作从不批量自动执行，仍然是一台一张确认卡片，卡片带着自己的主机，确认后只落到那台。助手只能操作本轮选中的主机：模型若编造出一个不在名单里的机器名/IP，会被直接拒绝并告诉它“没有这台主机”，不会去连陌生的地址
- MCP 工具挂载：在 AI 设置里添加 MCP（Model Context Protocol）服务，支持 `stdio`（本地命令，如 `npx -y ...`）与 `http`（远程 Streamable HTTP）两种传输；保存前可“测试连接”查看该服务提供的工具。挂载后助手的工具列表会自动带上这些工具（模型侧名字为 `mcp__<服务ID>__<工具名>`），可以和内置工具一起在同一轮对话里调用；某个服务连不上只会丢掉它自己的工具，不影响整轮对话。服务定义加密保存在数据库中（环境变量/请求头的值不会回显给浏览器），由管理员维护
- 扩展包（官方扩展机制）：在 AI 设置里按来源安装扩展包 —— 本地目录、`npm:包名`（含 `@范围/包@版本`）或 `git:仓库地址@分支/标签`，安装目录默认在数据库同级的 `data/extensions`（可用 `EXTENSIONS_DIR` 改）；每个包可以单独启用/停用、重新加载或移除（移除只删掉服务端自动克隆的目录，本地目录不会被删）。包里的 `package.json` 用 `yaws` 字段声明 `extensions` / `skills` / `prompts`，不写就按约定的 `extensions/`、`skills/`、`prompts/` 目录读取。扩展模块导出一个 `activate(api)`（或 `export default`）即可注册工具（`registerTool`，支持 `parameters` JSON Schema 与 `readOnly`）、技能（`registerSkill`）、提示模板（`registerPrompt`）和系统提示补充（`registerPromptNote`），也能用 `api.on("tool_call", ...)` 给**所有**工具（内置/MCP/扩展）加一道守卫，返回 `{block:true, reason}` 即可拦下危险操作。挂载后：扩展工具以 `ext__<包ID>__<工具名>` 加入助手工具列表并自动执行（卡片上标注“只读/可写”），技能只把名字和描述写进系统提示、需要时由助手调用 `read_skill` 读取全文，提示模板用 `/名字 参数` 触发（支持 `$ARGUMENTS` 与 `{{ args }}`；数据库里仍保存你输入的原文，只有发给模型时才展开）。包列表加密保存在数据库中，只有管理员能改动；扩展包会在服务端以主控进程的权限运行代码，因此只应安装可信来源
- 浏览器标签标题跟随当前页面：进入某台机器的终端时显示该机器名（如 `Fixture 1 · YAWS`），列表/设置/延迟监控等页面显示各自名称，多开标签时一眼能分清哪个是哪个- 证书自动管理：通过机器 SSH 扫描常见证书目录，识别域名/到期时间；支持 Cloudflare DNS 申请 Let’s Encrypt 证书、备份回滚、`nginx -t` 校验及 Nginx reload；删除/隐藏只在主控清单生效，留下“已隐藏”记录，重新扫描不会自动恢复
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
- 每台机器进入 SSH 工作区前须核对并保存 SSH 主机指纹。可在服务器运行 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256`（以服务端实际使用的主机密钥为准）。连接地址或指纹变化后需重新核实。已信任的机器不会重新弹指纹面板：只有确认过“没信任”或指纹真的变了才会显示。
- 内网机器可以挂在一台跳板机上：机器详情的 SSH 面板里给每台机器选一个「中转主机」，之后的终端、文件、证书扫描、Agent 安装和助手都会自动经它跳过去（与 `ProxyJump` 同款做法：先登录中转主机，再在会话内转发到目标机器的 SSH 端口），目标机器不需要公网端口。中转最多两层，保存时就会拒绝“指向自己”或“绕成环”的设置（`via_self`/`via_loop`/`via_depth`），连接时也会用同一套规则再检查一遍，坏数据不会导致一直重连。
- 中转主机自己必须已配置 SSH 账号并且指纹已确认：跳板机身份没确认时会提示 `via_untrusted`（从不可信的跳板机转发出去没有意义）。目标机器的指纹照旧单独确认，内网机器的指纹也是经中转读回来的，所以确认面板里显示的就是目标机器真正的公钥。中转主机需要允许端口转发（OpenSSH 默认配置即可；`AllowTcpForwarding no` 会返回 `via_forward_denied`）。删除一台中转主机时，挂在它下面的机器会自动改回直连，不会留下连不上的死链。
- 在跳板机的终端页，侧边栏「快捷指令」下方有「内网 SSH」面板：列出所有经这台机器访问的内网机器，可以直接连接（等于新开一个该机器的会话）；点 `+` 可原地新增一台内网机器（名称、Host、端口、用户名、密码或私钥），默认就挂在这台跳板机下。同一台内网机器在机器详情里也只是一台普通机器，退出中转设置即可恢复直连。
- 会话条下面的每个标签就是一台服务器的完整工作区（终端、文件、AI 各一份）。后台会话只是隐藏不卸载，SSH 连接和屏幕内容都保留，切回来立即可用；关闭标签只关那一台。达到上限时终端区会提示“同时打开的终端太多了，请先关闭不用的终端”，按提示关掉不需要的标签即可。
- “快捷指令”按机器保存，默认折叠，点击标题展开已保存的命令（徽标显示条数，折叠状态在浏览器中记住）；可插入终端或确认后执行。“文件”通过同一 SSH 用户的 SFTP 权限访问，识别 Nginx、Apache、Caddy、Docker、宝塔、1Panel 等常见目录，同时支持手动路径。
- 文件编辑器带语法高亮：优先按文件名/扩展名匹配（JSON/YAML/Shell/Nginx/Dockerfile/服务单元/`.env`/点文件等），无扩展名时再按 `#!` 识别解释器，工具栏右侧会显示当前语言；未知类型按纯文本处理，超过 400 KiB 的文件自动关闭高亮以保持流畅。
- 在“文件”或“AI”标签页时 SSH 终端会固定显示在右侧（窄屏时改为底部），可直接在编辑器旁执行命令；两个面板之间的分隔条可拖动调整比例（方向键微调、`Shift`/`PageUp`/`PageDown` 大步、`Home`/`End` 到两端、双击恢复默认），比例记在浏览器中；标签栏右侧的按钮可随时收起/展开终端面板。
- 触屏设备上终端默认显示按键栏（Esc/Tab/方向键/^C 等控制键、常用符号、粘贴、回车），Ctrl/Alt 为粘滞修饰键；按键栏可通过标签栏的键盘按钮隐藏，选择会记在浏览器中。
- 助手的多机模式：对话框底部的「主机」按钮显示本轮可用主机数（如 `主机 1/3`），点开是一份勾选列表（列表锚定在按钮上、绘制在页面最上层，不会被助手面板自身的滚动区域裁掉）。当前机器的标签页就是主机器（列表里显示“主”，不会重复出现），勾上其它机器后，本轮提问的主机集合就是“主机器 + 勾选项”；选中的主机会在输入框上方以标签列出，勾选状态随对话一起保存在服务端，重新打开这段对话时会恢复。因此：想在 `web-1` 上操作却顺手在 `db-1` 的标签页里提问，不必切标签——把 `db-1` 勾上即可。
- 多机模式下助手多了两个工具：`list_hosts`（列出本轮主机，带 `#ID`）与 `run_on_hosts`（在全部或指定的主机上跑**同一条只读**命令，逐台返回输出与退出码；其中一台连不上也会照常返回其它几台的结果）。`run_command`、`read_log`、`server_stats`、`write_file` 等工具都多了 `host` 参数（可写机器名、`#ID` 或纯数字 ID，不写就是主机器），另外 `run_command`/`read_log`/`run_on_hosts` 还有 `cwd` 参数，便于目标机器的应用目录和工作区根目录不一致时先切到别处。文件类工具（`list_files`/`read_file`/`write_file`）仍然只在本轮工作目录内活动；目标机器布局不同时，让助手用 `run_command` 配绝对路径读取。
- 批量执行只限只读：`run_on_hosts` 遇到 `systemctl restart`、`apt install`、`rm` 这类会改动机器的命令不会执行，而是返回一条错误，让助手改成逐台调用 `run_command`（每台一张确认卡片）。这样做是为了避免一次“确认”在整片机群上同时生效。修改类卡片会在数据库里记下所属主机，审批与撤销都按卡片自己的主机执行，但只有该轮对话所属机器的操作者能确认。
- 助手在回答时不再“抢”滚动条：只有你停在最后一行时才会随内容自动往下跟；你往回翻着看某一步的
  操作（命令输出、diff、日志）时，新到的 token 和新的工具卡片都不会把画面拽走，滚动位置完全归你。
  翻回到底部就自动恢复跟随；右下角还会出现一个「回到最新」的圆形箭头（一直在最底部时它不显示），
  点它直接跳回最新内容并继续跟随。整轮真正结束时会补一次滚动，保证最终回答不被漏看。
- 助手的一轮回答**不再依赖发起它的那个网页连接**：刷新页面、关掉标签页、把悬浮面板收起来、切到别的
  页面，都不会中断模型和服务器上的操作。刷新后的页面会重新接上这一轮（服务端从第一帧回放），所以答案
  是完整的、而不是“刷新那一刻的半句”；服务端进程重启导致确实断掉的那一轮会明确提示“上一轮没有跑完”，
  不会一直空等。也因此“停止”变成了一个明确的动作：刷新过、甚至只是看着别人开的这一轮，都能点“停止”
  真正把它停下（接口 `POST /api/ai/conversations/:cid/runs/:runId/stop`），而断开连接不再等于停止。
- 一个面板可以**同时开多个终端、各自和助手对话**：每一轮都有自己的模型请求、SSH 连接和会话记录，
  互不阻塞（`MAX_RUNS_PER_USER = 8` / 服务端 `32`，超出会返回“同时运行的 AI 任务太多”而不是排队）。
  同一个对话同时只能跑一轮，第二个问题会明确提示“这个对话正在运行”，避免两轮读同一份历史后
  互相覆盖；换一个终端/机器提问则完全不受影响。
- 回答不会因为“太长”而被截断：网关因为输出长度上限（`finish_reason: length` /
  `incomplete_details.reason: max_output_tokens`）把回答停在半句时，助手会把已经写好的部分回放给模型
  并让它**接着往后续写**（最多 12 轮），续写的文字直接追加在同一条回答里，状态行会显示「输出达到长度上限，
  正在续写第 N 段…」；真的到上限还没写完才提示“回复「继续」”。整轮的保护也从“总时长 30 分钟”改为
  “10 分钟没有任何新内容才中断”，所以慢模型写长回答不会再被时间掐断；单次响应体上限放宽到 8 MiB（流式 64 MiB）。
- “AI 助手”既是工作区的聊天标签页，也是可悬浮在终端、文件等任何标签页之上的附加面板（右下角按钮展开/收起）。悬浮面板可拖动标题栏移动到任意位置，右下角可调整大小，位置和尺寸记在浏览器中（双击标题栏回到默认右下角），拖动/缩放始终限制在可视区域内，手机上也不会盖住触屏按键栏。气泡、工具卡片和审批卡片各自排列并独立滚动（命令输出、日志、diff 在卡片内滚动），互不挤压；面板过小时设置表单会改为覆盖聊天区，保证消息区始终可用。聊天区下方常驻一条状态行（不在消息流里，因此不影响“回答固定在最后”的排版）：显示当前第几步、正在思考 / 正在读哪个文件或跑哪条命令 / 正在整理回答 / 等待你确认几个操作，并累计本轮用时；点“停止”后显示“已停止 · 用时 …”，出错显示“执行失败 · 用时 …”，只有整轮真正结束才显示“已完成 · 用时 …”（超过一步时还会给出总步数）。对话按机器保存，可继续提问或删除。助手的回答按 Markdown 渲染：标题、列表（含任务清单）、引用、表格、`行内代码`、代码块（带语言标签和一键复制）、加粗/斜体/删除线、链接（新标签页打开，`rel="noreferrer noopener"`）；不解析也不执行任何 HTML（助手回答和它读到的文件内容都只当文本显示），远程图片不会自动加载（只显示为链接）。一轮对话里的操作步骤（工具卡片、审批卡片）始终排在回答上方，回答固定在最后并用一条虚线分隔：模型先说话再调用工具时，读起来仍然是“先看做了什么，再看结论”。
- 工作区侧边栏的“快捷指令”下方显示该机器的服务器占用：CPU（两次 `/proc/stat` 采样，取不到时退回开机以来平均值）、内存/Swap（按 `MemAvailable` 计算）、各挂载点磁盘用量、占用最高的进程和网卡收发总量，主机指纹确认后每 15 秒自动刷新（页面切到后台时暂停，可手动暂停/刷新）。数据由主控通过 SSH 直接读取 `/proc`，不需要 Agent，也不需要 Node/Go 运行环境；快照缓存 5 秒并合并并发请求，同一机器同一时刻只探测一次。进程列表依赖 `procps`（Debian/Ubuntu: `apt install procps`；Alpine 的 busybox `ps` 不含 CPU 占用，此时只显示其他指标），容器文件绑定挂载（`/etc/hosts`、`/config` 等）会自动去重。各项占用条与主页使用同一套配色（绿/黄/红 + 毛玻璃），百分比数字同步变色。
- 文本编辑限制为 UTF-8、512 KiB；上传/下载限制为 8 MiB。上传不覆盖已有文件。保存会检查内容版本、保留原权限和所有者、生成 `.yaws-backup-*` 回滚副本（同一文件只保留最近 3 份，旧的自动清理），OpenSSH 使用原子替换；不支持扩展的 SFTP 使用保留原文件的回滚替换。ACL/xattr 不通过 SFTP 复制，特殊文件和二进制文件不支持在线编辑。
- AI 设置支持多个模型配置（最多 20 个）：可新建、复制、删除并随时在对话框顶部切换当前使用的配置（配置随账号保存在主控，浏览器也记住最近选择）；每个配置有自己的接口地址、模型、协议、推理级别、API Key 和“允许内网”开关，密钥不会回传给浏览器（留空表示不修改，可显式清除），复制配置需要重新填写密钥。接口地址支持完整路径或 `/v1` 基地址；`high`、`max` 等推理级别按提供方原样发送，具体支持范围由模型接口决定。模型必须支持工具调用。Responses 使用 `reasoning.effort`，Chat 使用 `reasoning_effort`。
- 对话选择器支持按标题、目录、模型、内容搜索，按“今天/昨天/最近 7 天/更早”分组，显示轮数、使用的模型和最后一条消息摘要，可直接重命名（也可删除）历史对话；键盘 `↑`/`↓` 选择、`Enter` 进入、`Esc` 关闭。
- 助手可使用 `list_files`、`read_file`、`read_log`、`run_command`、`server_stats`、`write_file` 六类工具，多机模式下再加上 `list_hosts` 与 `run_on_hosts`。命令分为“只读/修改/危险”三级：只读命令（`df`、`journalctl`、`docker ps`、`nginx -t` 等）可直接执行；“修改类命令也自动执行”开启后 `systemctl restart`、`apt install` 等无需逐条确认；`rm -rf`、`mkfs`、改密码、`chmod -R` 等危险命令永远需要人工确认。默认策略是“只读命令自动执行”。
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

### 方式 B：一键安装（推荐）

后台机器详情页的“探针配置”卡片里有两个按钮：

- **国内一键安装**：下载顺序为 Gitee → 主控 → GitHub
- **国外一键安装**：下载顺序为 GitHub → 主控 → Gitee

两条线路最终都会回退到主控自身的 `/api/agent/binary/<架构>`，所以即使被控端既连不上
GitHub 也连不上 Gitee，只要它能连上主控就能装好。点击后主控会通过 SSH 登录被控端执行
安装脚本，并把安装日志实时回显在页面上（可以随时“停止”）。

前提条件：

- 该机器已保存可用的 SSH 地址/账号/密码（或密钥），并且已在 SSH 面板确认过主机指纹
- 主控已生成该机器的探针密钥（机器详情页可重置）
- 安装脚本内的 agent key、地址等值都会被正确转义后写入被控端

也可以点“查看安装脚本”复制脚本，手动到被控端以 root 执行：

- 自动识别 `linux/amd64` 或 `linux/arm64`
- 逐个来源尝试下载，只有 `-version` 能正常返回的二进制才算下载成功，能拿到校验和时会校验 SHA256
- 写入 `/etc/yaws-agent.json`（权限 0600）并安装 systemd 服务（无 systemd 则 fallback 后台运行）
- 已安装版本与主控自带版本一致时跳过下载（`--check` 只检查，`--force` 强制重装）

主控自带的探针来自仓库里的 `agent/bin/`（Docker 镜像也会带上），可通过环境变量调整：

| 变量 | 说明 |
| --- | --- |
| `AGENT_BINARY_DIR` | 探针二进制所在目录，默认 `<仓库>/agent/bin` |
| `AGENT_GITHUB_REPO` | GitHub 发布仓库，默认 `yamatu/yaws` |
| `AGENT_GITEE_REPO` | Gitee 镜像仓库，留空则关闭国内发布源，默认 `yamatu/yaws` |
| `AGENT_RELEASE_BASE_URL` / `AGENT_GITEE_RELEASE_BASE_URL` | 自定义下载前缀（镜像站） |
| `AGENT_RELEASE_TAG` | 固定发布版本（Gitee 没有 `/releases/latest/download` 别名，不固定时会走 Gitee API 查最新 tag） |

只配置了的来源才会出现在下载顺序里（例如把 `AGENT_GITEE_REPO` 留空，国内线路就只剩主控 → GitHub），
所以日志里出现的一定是真的会去试的地址。

#### 发布探针二进制

`agent/bin/` 里的两个二进制就是主控对外提供的版本，请与最新发布保持一致（否则可以把
`AGENT_BINARY_DIR` 指到你放发布文件的目录）。打 `v*` tag 后 `.github/workflows/release-agent.yml`
会构建 linux/amd64 与 linux/arm64 并发布到 GitHub；Gitee 侧需要额外配置：

1. 在 Gitee 上生成私人令牌（设置 → 私人令牌，勾选 `projects`）；
2. 在 GitHub 仓库的 Settings → Secrets and variables → Actions 里添加 secret `GITEE_TOKEN`
   （可选：用 variable `GITEE_REPO` 指定 Gitee 仓库，默认与 GitHub 仓库同名）；
3. 之后再打 tag，工作流会同时发布到 Gitee。已有的 tag 可以在 Actions 里手动
   `Run workflow` 并填入 tag 补发布；

本地手动发布同样可以（`GITEE_TOKEN` 也可以临时用环境变量传）：

```bash
GITEE_TOKEN=<私人令牌> scripts/gitee-release.sh v0.3.0
```

Gitee 没有“最新发布”下载别名，所以必须要有一个 release 把三个文件挂上去
（`yaws-agent-linux-amd64`、`yaws-agent-linux-arm64`、`SHA256SUMS`），国内线路才会真的从
Gitee 下载；没有 release 时该来源会被跳过并回退到主控。脚本可重复执行，已发布的附件不会重复上传。

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
- **AI 助手**：远程编辑会在目标文件旁生成 `.yaws-backup-<时间戳>-<随机>` 回滚副本，只保留最近 3 份；助手写入（含自动执行）后可一键还原，还原同样校验文件版本，避免覆盖他人改动。一轮提问没有“分析步数”限制：助手会一直读文件、跑命令直到把事做完再给结论，不会在回答里塞“已达到步数上限”。仍然保留的是兜底护栏（单轮最多 60 次工具调用、上下文大小、5 分钟超时），它们只在模型陷入死循环时生效；多台机器（或多个对话）可以同时向助手提问，互不排队（每用户最多 8 个、整机最多 32 个并发运行），只有同一个对话保持独占：同一对话里发第二个问题会返回 409 `ai_conversation_busy`，避免两轮回答把同一份历史改乱；`rm -rf`、`mkfs`、`shred`、改密码、`curl | sh` 等危险模式即使开启自动执行也强制走人工确认。
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

清理不需要的证书记录：证书清单每行右侧的“删除”会把该条记录从主控清单隐藏起来；清单上方还有“隐藏已到期（N）”“隐藏异常（N）”两个批量按钮，只作用于当前选中的服务器。删除/隐藏**只影响主控清单，不会删除服务器上的证书文件，也不会执行任何远程命令**；被隐藏的证书不再参与自动续期，而且**再次扫描也不会自动恢复**（删除会留下一条“已隐藏”的记录，否则扫描会重新发现同一个文件并把记录加回来）。点清单上方的“显示已隐藏（N）”可以看到这些记录并逐条“恢复”，或点“恢复全部”一次性放回清单。手动对同一路径重新申请证书会自动取消隐藏。想彻底停止续期某个证书时，应先在服务器上删除/停用对应站点，再做隐藏。

远程脚本兼容性：续期/申请脚本会被登录 shell 解析，Debian/Ubuntu（`dash`）与 Alpine（`busybox ash`）不支持 bash 专用的 `trap ... ERR`，所以脚本不再依赖 ERR trap，而是每一步用 `|| fail <code>` 自行处理并在失败时调用 `restore` 回滚备份；`acme.sh` 的 `--install-cert` 会先按默认方式尝试，失败后用 `--ecc` 重试，以兼容 ECC/RSA 两种证书目录。

错误码与常见原因：

- 机器列表会直接标出 SSH 凭据状态。出现“SSH 密码/私钥无法解密”说明 `AGENT_KEY_SECRET`（未设置时回退到 `JWT_SECRET`）与保存密码时不一致，扫描必然失败。
- 修复方式二选一：到机器详情重新保存一次 SSH 密码/私钥；或把旧密钥配到 `AGENT_KEY_SECRET_PREVIOUS` 后重启一次，程序会自动把旧的密文重新加密成新密钥（`ssh_password_enc`、`ssh_key_enc`、`agent_key_enc` 都支持轮换）。
- `ssh_auth_failed`：用户名或密码/私钥不正确（密码能解密但服务器拒绝登录）。
- `ssh_host_untrusted` / `ssh_host_key_changed`：需要先在机器详情完成或重新做指纹信任。
- `via_self` / `via_loop` / `via_depth`：中转设置指向自己、形成环路或超过两层，保存时会被拒绝，请换一台主机。
- `via_not_configured`：选作中转的那台机器还没保存 SSH 地址/登录凭据，先把它自己的 SSH 面板填完。
- `via_untrusted`：中转主机的指纹还没确认（目标机器自己的指纹另有提示 `ssh_host_untrusted`）。
- `via_failed` / `via_forward_denied`：经中转登录失败，或中转主机不允许端口转发（检查它的 `AllowTcpForwarding`，OpenSSH 默认是允许的）。
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
