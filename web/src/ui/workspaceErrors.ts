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
  ai_busy: "AI 任务正在运行，请稍后重试",
  outside_workspace: "路径不在选定工作目录中",
  sensitive_file_blocked: "AI 不允许读取凭据文件",
  private_ai_endpoint_blocked: "接口指向内网地址，请检查 AI 设置",
  https_required: "AI 接口需要 HTTPS",
  workspace_timeout: "文件操作超时",
  workspace_busy: "该机器正在处理其他操作，请稍后重试",
  forbidden: "仅管理员可用",
  model_network_error: "AI 接口连接失败或超时",
  model_http_401: "AI 密钥无效",
  model_http_400: "AI 接口拒绝请求，请检查模型、协议和推理级别",
  model_http_404: "AI 接口路径或模型不存在",
  cancelled: "操作已取消",
  file_path_changed: "文件路径发生变化，请重新生成方案",
};
export function workspaceError(error: unknown) {
  const text = error instanceof Error ? error.message : "请求失败";
  return errors[text] ?? text;
}
