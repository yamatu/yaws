const errors: Record<string, string> = {
  ssh_host_untrusted: "请先确认 SSH 主机指纹",
  ssh_host_key_changed: "SSH 主机指纹已变化，请核实服务器身份",
  ssh_authentication: "SSH 认证失败",
  ssh_not_configured: "请先在机器详情中配置 SSH",
  file_changed: "文件已变化或已存在，请重新打开后再保存",
  file_busy: "文件正在保存，请稍后重试",
  file_too_large: "文件超过大小限制",
  not_utf8_text: "非 UTF-8 文本，请下载后编辑",
  binary_file: "二进制文件不能在文本编辑器中打开",
  not_regular_file: "不支持编辑特殊文件",
  ai_not_configured: "请先配置 AI 接口和模型",
  ai_busy: "同时运行的 AI 任务太多，请等其中一个结束后再试",
  ai_conversation_busy: "这个对话正在运行，请等它结束或先停止",
  ai_failed: "AI 请求失败，请检查接口设置或稍后重试",
  ai_context_limit: "读取的内容过多，请缩小问题范围",
  ai_tool_limit: "本轮操作过多，请再追问一次继续处理",
  ai_timeout: "长时间没有新内容已自动结束，回复「继续」可以让它接着写",
  cancelled: "本轮已取消",
  bad_tool_arguments: "AI 生成的参数无效，请换个说法再试",
  proposal_already_handled: "这条操作已经被处理过了",
  proposal_not_applied: "只有已应用的修改才能撤销",
  confirmation_required: "需要先确认才能执行",
  not_found: "记录不存在或已被删除",
  bad_request: "请求参数不正确",
  model_dns_failed: "AI 接口域名解析失败",
  outside_workspace: "路径不在选定工作目录中",
  sensitive_file_blocked: "AI 不允许读取凭据文件",
  private_ai_endpoint_blocked: "接口指向内网地址，请检查 AI 设置",
  https_required: "AI 接口需要 HTTPS",
  workspace_timeout: "文件操作超时",
  workspace_busy: "该机器正在处理其他操作，请稍后重试",
  ssh_connect_failed: "SSH 连接失败，请检查地址、端口和防火墙",
  connect_timeout: "SSH 连接超时，请检查服务器是否可达",
  session_limit: "同时打开的终端太多了，请先关闭不用的终端",
  idle_timeout: "终端长时间没有操作，已自动断开",
  slow_client: "终端输出过快，本地无法及时处理，连接已断开",
  input_limit: "输入过快，连接已断开",
  duplicate_connect: "这个终端重复发起了连接",
  bad_message: "终端会话出现异常数据，连接已断开",
  shell_failed: "远程服务器无法启动交互式终端",
  shell_error: "远程终端出错，连接已断开",
  socket_closed: "终端连接已关闭",
  socket_error: "终端连接出错",
  ssh_error: "SSH 连接出错，请重试",
  ws_error: "终端连接中断，请重试",
  terminal_init_failed: "终端初始化失败，请刷新页面重试",
  ssh_timeout: "SSH 连接超时",
  ssh_closed: "SSH 连接已断开",
  ssh_auth_failed: "SSH 认证失败，请检查用户名和密码/密钥",
  ssh_password_missing: "未保存 SSH 密码",
  ssh_key_missing: "未保存 SSH 私钥",
  ssh_credentials_invalid: "SSH 凭据无法解密，请重新保存密码或密钥",
  ssh_key_invalid: "SSH 私钥无法解密，请重新保存密钥",
  ssh_address_changed: "SSH 地址已变化，请重新确认主机指纹",
  ssh_host_unavailable: "无法连接 SSH 主机",
  via_self: "中转主机不能是这台机器自己",
  via_loop: "中转设置形成了环路，请换一台主机",
  via_depth: "中转层数太多，最多两层中转",
  via_not_configured: "中转主机还没有配置 SSH 登录信息",
  via_untrusted: "请先确认中转主机的 SSH 主机指纹",
  via_failed: "未能通过中转主机建立连接",
  via_forward_denied: "中转主机拒绝了端口转发（检查 AllowTcpForwarding）",
  exec_failed: "远程命令执行失败",
  command_timeout_or_cancelled: "远程命令超时",
  command_output_limit: "远程命令输出过多",
  forbidden: "仅管理员可用",
  model_network_error: "AI 接口连接失败或超时",
  model_invalid_json: "AI 接口返回了无法解析的数据",
  model_response_too_large: "AI 返回的内容过大，已中断",
  model_timeout: "AI 接口响应超时",
  model_http_401: "AI 密钥无效",
  model_http_400: "AI 接口拒绝请求，请检查模型、协议和推理级别",
  model_http_404: "AI 接口路径或模型不存在",
  file_path_changed: "文件路径发生变化，请重新生成方案",
  mcp_command_required: "请填写 MCP 服务的启动命令",
  mcp_url_invalid: "MCP 服务地址无效，需要 http(s) 地址",
  duplicate_mcp_server: "存在重复的 MCP 服务标识",
  mcp_server_not_found: "MCP 服务不存在或已被删除",
  mcp_call_failed: "调用 MCP 工具失败",
  mcp_invalid_tool_list: "MCP 服务返回的工具列表无法解析",
  mcp_no_response: "MCP 服务没有返回结果",
  extension_source_invalid:
    "扩展包来源无效，请填写本地目录、npm:包名 或 git:仓库地址",
  extension_package_missing: "找不到扩展包目录或入口文件",
  duplicate_extension: "这个扩展包来源已经安装过了",
  extension_limit: "安装的扩展包太多了，请先移除不用的",
  extension_not_found: "扩展包不存在或已被移除",
  extension_tool_not_found: "扩展工具不存在，请重新加载扩展",
  extension_no_activate: "扩展包没有可加载的入口或清单",
  extension_timeout: "扩展工具执行超时",
  extension_install_timeout: "扩展包安装超时，请检查网络",
  extension_call_failed: "调用扩展工具失败",
  blocked_by_extension: "扩展包拦截了这个操作",
  skill_not_found: "技能不存在，请重新加载扩展",
  host_not_found: "这台主机不在当前对话的主机列表里，请重新勾选后再试",
  host_not_configured: "这个对话还没有配置可用的主机",
  host_ambiguous: "有多台主机同名，请改用主机编号",
  too_many_hosts: "一次选择的主机太多，请减少后重试",
  agent_binary_missing: "主控没有内置探针，请改用发布版下载或配置 AGENT_BINARY_DIR",
  agent_install_running: "这台机器正在安装探针，请等待本次安装结束",
  ssh_exec_failed: "被控端无法执行安装命令",
  agent_install_failed: "安装探针失败，请看日志里的报错",
};
export function workspaceError(error: unknown) {
  const text = error instanceof Error ? error.message : "请求失败";
  if (errors[text]) return errors[text];
  // MCP failures carry dynamic detail (method, exit code, HTTP status).
  if (text.startsWith("mcp_timeout")) return "MCP 服务响应超时";
  if (text.startsWith("mcp_http_"))
    return `MCP 服务返回 HTTP ${text.slice("mcp_http_".length)}`;
  if (text.startsWith("mcp_exit")) return "MCP 服务进程已退出";
  if (text.startsWith("mcp_rpc")) return "MCP 服务返回错误";
  if (text.startsWith("spawn "))
    return "无法启动 MCP 服务，请检查启动命令是否存在";
  if (text.startsWith("extension_install_failed")) {
    const detail = text.slice("extension_install_failed".length).replace(/^:\s*/, "");
    return detail ? `扩展包安装失败：${detail}` : "扩展包安装失败";
  }
  if (text.startsWith("agent_install_failed")) {
    const detail = text.slice("agent_install_failed".length).replace(/^:\s*/, "");
    return detail ? `安装探针失败（退出码 ${detail}）` : "安装探针失败";
  }
  if (text.startsWith("ssh_exec_failed")) return "被控端无法执行安装命令";
  if (text.startsWith("extension_unloadable")) {
    const detail = text.slice("extension_unloadable".length).replace(/^:\s*/, "");
    return detail ? `扩展包无法加载：${detail}` : "扩展包无法加载";
  }
  if (text.startsWith("extension_tool_invalid")) {
    const detail = text.slice("extension_tool_invalid".length).replace(/^:\s*/, "");
    return detail ? `扩展工具定义无效：${detail}` : "扩展工具定义无效";
  }
  if (text.startsWith("extension_no_activate")) {
    const detail = text.slice("extension_no_activate".length).replace(/^:\s*/, "");
    return detail
      ? `扩展包没有可加载的内容：${detail}`
      : "扩展包没有可加载的入口或清单";
  }
  return text;
}
