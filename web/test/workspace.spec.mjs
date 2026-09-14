import test, { before, after } from "node:test";
import { expect, chromium } from "@playwright/test";
import { harness } from "../../server/test/fixture.mjs";
let f, browser;
before(async () => {
  f = await harness();
  browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || "msedge",
    headless: true,
  });
});
after(async () => {
  await browser?.close();
  await f?.close();
});
function browserTest(name, fn) {
  test(name, { timeout: 90000 }, async () => {
    const page = await browser.newPage();
    try {
      await fn({ page });
    } catch (e) {
      console.log(await page.locator("body").innerText());
      await page.screenshot({
        path: "test-results/failure.png",
        fullPage: true,
      });
      throw e;
    } finally {
      await page.close();
    }
  });
}
browserTest(
  "desktop workspace: trust, shortcuts, files, AI chat, machine Ping",
  async ({ page }) => {
    const failures = [];
    page.on("pageerror", (error) => failures.push(error.message));
    await page.goto(f.url + "/login");
    await page.getByPlaceholder("请输入用户名").fill("fixture");
    await page.getByPlaceholder("请输入密码").fill(f.password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("link", { name: "堡垒机", exact: true }).click();
    await page.getByRole("link", { name: "进入终端" }).first().click();
    await page
      .getByRole("button", { name: "读取主机指纹", exact: true })
      .click();
    await expect(page.locator(".host-key-prompt")).toContainText("SHA256:");
    // The resource probe is refused until the host key is trusted.
    await expect(page.locator(".stats-panel")).toContainText(
      "确认主机指纹后可查看实时占用情况",
    );
    await page.getByRole("button", { name: "确认并信任此指纹" }).click();
    await expect(page.locator(".workspace-header")).toContainText("已连接");
    // The shortcut list starts folded; the resource panel keeps its space.
    const shortcutToggle = page.locator(".shortcut-toggle");
    await expect(shortcutToggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".shortcut-item")).toHaveCount(0);
    await expect(page.locator(".shortcut-form")).toHaveCount(0);
    await expect(page.locator(".stats-panel")).toBeVisible();
    // Adding a command unfolds the list.
    await page.getByRole("button", { name: "添加指令", exact: true }).click();
    await expect(shortcutToggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".shortcut-form")).toBeVisible();
    await page.getByLabel("指令名称").fill("健康检查");
    await page.getByLabel("指令内容").fill("uptime");
    await page
      .locator(".shortcut-form")
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await expect(page.locator(".shortcut-item")).toContainText("健康检查");
    await expect(page.locator(".shortcut-count")).toContainText("1");
    // Folding keeps the saved command and its count one click away.
    await shortcutToggle.click();
    await expect(shortcutToggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".shortcut-item")).toHaveCount(0);
    await expect(page.locator(".shortcut-count")).toBeVisible();
    await expect(page.locator(".shortcut-count")).toContainText("1");
    await expect(page.locator(".stats-panel")).toBeVisible();
    await shortcutToggle.click();
    await expect(page.locator(".shortcut-item")).toContainText("健康检查");
    page.on("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("button", { name: "执行 健康检查", exact: true })
      .click();
    // Resource usage sits below the shortcut list in the same sidebar.
    const stats = page.locator(".stats-panel");
    await expect(stats).toContainText("服务器占用");
    await expect(stats).toContainText("33%");
    await expect(stats).toContainText("69%");
    await expect(stats).toContainText("2.5 GB / 3.7 GB");
    await expect(stats).toContainText("78%");
    await expect(stats).toContainText("94%");
    await expect(stats).toContainText("/data");
    await expect(stats).toContainText("fixture-ssh");
    await expect(stats).toContainText("node");
    await expect(stats.locator(".stat-bar-fill.level-warn")).toHaveCount(1);
    await expect(stats.locator(".stat-bar-fill.level-high")).toHaveCount(1);
    // cpu, memory and swap are all below the warn threshold.
    await expect(stats.locator(".stat-bar-fill.level-ok")).toHaveCount(3);
    await expect(stats).toContainText("Swap");
    const sidebarOrder = await page.evaluate(() => {
      const box = (sel) =>
        document.querySelector(sel)?.getBoundingClientRect().top;
      return {
        item: box(".shortcut-item"),
        stats: box(".stats-panel"),
        pane: box(".shortcut-panel"),
      };
    });
    expect(sidebarOrder.stats).toBeGreaterThan(sidebarOrder.item);
    expect(sidebarOrder.stats).toBeGreaterThan(sidebarOrder.pane);
    await page.screenshot({
      path: "test-results/terminal-desktop.png",
      fullPage: true,
    });
    await page.getByRole("tab", { name: "文件", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "刷新目录", exact: true }),
    ).toBeEnabled();
    await page.getByLabel("目录路径").fill("/srv/app");
    await page.getByRole("button", { name: "打开目录", exact: true }).click();
    await page
      .getByRole("button", { name: "config.json", exact: true })
      .click();
    await expect(page.locator(".cm-content")).toContainText("enabled");
    await expect(page.locator(".editor-lang-tag")).toContainText("JSON");
    // The SSH session stays docked next to the file editor.
    await expect(page.locator(".workspace-body.docked")).toHaveCount(1);
    await expect(page.locator(".workspace-body.docked .xterm")).toBeVisible();
    await page.getByRole("button", { name: "隐藏终端面板" }).click();
    await expect(page.locator(".workspace-body.docked")).toHaveCount(0);
    await expect(page.locator(".terminal-workspace")).toBeHidden();
    await page.getByRole("button", { name: "在文件编辑时显示终端" }).click();
    await expect(page.locator(".workspace-body.docked .xterm")).toBeVisible();
    await page
      .locator(".cm-content")
      .fill('{"enabled":false,"browser":true}\n');
    await page.getByRole("button", { name: "保存文件", exact: true }).click();
    await expect(page.locator(".workspace-notice")).toContainText("已保存");
    await page.locator("input[type=file]").setInputFiles({
      name: "browser-upload.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("browser upload"),
    });
    await expect(page.locator(".file-list")).toContainText(
      "browser-upload.txt",
    );
    await page.screenshot({
      path: "test-results/files-desktop.png",
      fullPage: true,
    });
    // The docked terminal is resizable: dragging the divider widens it.
    const paneWidth = () =>
      page.locator(".terminal-workspace").boundingBox().then((b) => b.width);
    const splitter = page.getByRole("separator", { name: "调整终端面板比例" });
    await expect(splitter).toBeVisible();
    const narrow = await paneWidth();
    const divider = await splitter.boundingBox();
    await page.mouse.move(divider.x + divider.width / 2, divider.y + 40);
    await page.mouse.down();
    await page.mouse.move(divider.x - 140, divider.y + 40, { steps: 8 });
    await page.mouse.up();
    const wide = await paneWidth();
    expect(wide).toBeGreaterThan(narrow + 60);
    const savedSplit = await page.evaluate(() =>
      localStorage.getItem("yaws.workspace.split"),
    );
    expect(Number(savedSplit)).toBeLessThan(64);
    // The keyboard works too, and double clicking restores the default.
    await splitter.focus();
    await page.keyboard.press("ArrowRight");
    expect(Number(await page.evaluate(
      () => localStorage.getItem("yaws.workspace.split"),
    ))).toBeGreaterThan(Number(savedSplit));
    await splitter.dblclick();
    expect(Number(await page.evaluate(
      () => localStorage.getItem("yaws.workspace.split"),
    ))).toBe(64);
    // The assistant is a chat: ask a question, approve anything that touches the server.
    await page.getByRole("tab", { name: "AI", exact: true }).click();
    const form = page.locator(".ai-settings");
    await expect(form).toBeVisible();
    await form.getByLabel("名称", { exact: true }).fill("主力模型");
    await form.getByLabel("API 地址", { exact: true }).fill(f.modelUrl);
    await form.getByLabel("模型", { exact: true }).fill("fixture-model");
    await form.getByLabel("API Key", { exact: true }).fill("fixture-key");
    await form.getByLabel("允许内网 / HTTP 接口", { exact: true }).check();
    await page.getByRole("button", { name: "保存全部配置", exact: true }).click();
    await expect(page.locator(".ai-chat .workspace-notice")).toContainText(
      "AI 设置已保存",
    );
    await expect(page.locator(".ai-chat-profile")).toContainText("主力模型");
    await expect(page.locator(".ai-chip")).toHaveCount(3);
    // A second configuration can be added and switched to.
    await page.getByRole("button", { name: "AI 设置", exact: true }).click();
    await expect(page.locator(".ai-profile-chip")).toHaveCount(1);
    await page.getByRole("button", { name: "新建配置", exact: true }).click();
    await form.getByLabel("名称", { exact: true }).fill("快速模型");
    await form.getByLabel("API 地址", { exact: true }).fill(f.modelUrl);
    await form.getByLabel("模型", { exact: true }).fill("fixture-model");
    await form.getByLabel("API Key", { exact: true }).fill("second-key");
    await form.getByLabel("允许内网 / HTTP 接口", { exact: true }).check();
    await page.getByRole("button", { name: "保存全部配置", exact: true }).click();
    await page.getByRole("button", { name: "AI 设置", exact: true }).click();
    await expect(page.locator(".ai-profile-chip")).toHaveCount(2);
    await expect(page.locator(".ai-profile-chip").first()).toContainText(
      "主力模型",
    );
    await page.getByRole("button", { name: "AI 设置", exact: true }).click();
    await page.getByLabel("模型配置", { exact: true }).selectOption("主力模型");
    await expect(page.locator(".ai-settings")).toHaveCount(0);
    await page.getByLabel("问题").fill("[run] 看一下磁盘");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".ai-bubble")).toContainText("[run] 看一下磁盘");
    await expect(page.locator(".ai-tool")).toContainText("df -h /");
    await expect(page.locator(".ai-tool-state")).toContainText("完成");
    await expect(page.locator(".ai-answer")).toContainText(
      "已生成配置修改与验证命令。",
    );
    // Each configuration carries its own API key.
    expect(f.modelRequests.at(-1).headers.authorization).toBe(
      "Bearer fixture-key",
    );
    await expect(page.locator(".ai-chat-session")).toContainText("主力模型");
    // Anything mutating waits for an approval card instead of running.
    await page.getByLabel("问题").fill("[write] 重启 nginx");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const approval = page.locator(".ai-proposal").last();
    await expect(approval).toContainText("systemctl restart nginx");
    await expect(approval).toContainText("需要你确认");
    await expect(page.locator(".ai-chat-pending")).toContainText("1 条操作");
    expect(f.commands.some((c) => c.includes("systemctl restart nginx"))).toBe(
      false,
    );
    await page.screenshot({
      path: "test-results/ai-desktop.png",
      fullPage: true,
    });
    await approval.getByRole("button", { name: "执行命令", exact: true }).click();
    await expect(approval).toContainText("已执行");
    expect(f.commands.some((c) => c.includes("systemctl restart nginx"))).toBe(
      true,
    );
    // The conversation picker searches, groups, renames and deletes.
    await page.getByRole("button", { name: "选择对话", exact: true }).click();
    await expect(page.locator(".ai-conv-pop")).toBeVisible();
    await expect(page.locator(".ai-conv-group-label")).toContainText("今天");
    await expect(page.locator(".ai-conv-row")).toHaveCount(1);
    await expect(page.locator(".ai-conv-row").first()).toContainText("2 轮");
    await page.getByLabel("搜索对话", { exact: true }).fill("重启");
    await expect(page.locator(".ai-conv-row")).toHaveCount(1);
    await expect(page.locator(".ai-conv-row").first()).toContainText("重启");
    await page.getByLabel("搜索对话", { exact: true }).fill("没有这段内容");
    await expect(page.locator(".ai-conv-empty")).toContainText("没有匹配");
    await page.getByLabel("搜索对话", { exact: true }).fill("磁盘");
    await expect(page.locator(".ai-conv-row")).toHaveCount(1);
    await page.getByLabel("清除搜索", { exact: true }).click();
    await page.locator(".ai-conv-row").first().getByLabel(/^重命名/).click();
    await page.getByLabel("对话名称", { exact: true }).fill("磁盘排查");
    await page.getByLabel("保存名称", { exact: true }).click();
    await expect(page.locator(".ai-conv-row").first()).toContainText("磁盘排查");
    // A fresh conversation from the picker is kept next to the first one.
    await page
      .locator(".ai-conv-pop")
      .getByRole("button", { name: "新对话", exact: true })
      .click();
    await expect(page.locator(".ai-chat-transcript")).not.toContainText(
      "看一下磁盘",
    );
    await page.getByLabel("问题").fill("[list] 看看目录");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".ai-answer")).toContainText(
      "已生成配置修改与验证命令。",
    );
    await page.getByRole("button", { name: "选择对话", exact: true }).click();
    await expect(page.locator(".ai-conv-row")).toHaveCount(2);
    await page.locator(".ai-conv-row").first().getByLabel(/^删除/).click();
    await expect(page.locator(".ai-conv-confirm")).toContainText("删除「");
    await page.getByLabel("确认删除", { exact: true }).click();
    await expect(page.locator(".ai-conv-row")).toHaveCount(1);
    // Picking the remaining conversation brings its transcript back.
    await page.locator(".ai-conv-row").first().locator(".ai-conv-pick").click();
    await expect(page.locator(".ai-conv-pop")).toHaveCount(0);
    await expect(page.locator(".ai-conv-trigger")).toContainText("磁盘排查");
    await expect(page.locator(".ai-chat-transcript")).toContainText(
      "看一下磁盘",
    );
    // Escape closes the popover.
    await page.getByRole("button", { name: "选择对话", exact: true }).click();
    await expect(page.locator(".ai-conv-pop")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".ai-conv-pop")).toHaveCount(0);
    // The same assistant floats over the terminal as an add-on panel.
    await page.getByRole("tab", { name: "终端", exact: true }).click();
    await page.getByRole("button", { name: "AI 助手", exact: true }).click();
    await expect(page.locator(".ai-dock")).toBeVisible();
    await expect(page.locator(".ai-dock .ai-chat-transcript")).toContainText(
      "看一下磁盘",
    );
    // The floating panel can be dragged anywhere and resized from its corner.
    const dock = page.locator(".ai-dock");
    const home = await dock.boundingBox();
    await page.mouse.move(home.x + 70, home.y + 12);
    await page.mouse.down();
    await page.mouse.move(home.x - 260, home.y - 50, { steps: 10 });
    await page.mouse.up();
    const moved = await dock.boundingBox();
    expect(moved.x).toBeLessThan(home.x - 120);
    expect(moved.y).toBeLessThan(home.y - 20);
    const storedBox = JSON.parse(
      await page.evaluate(() => localStorage.getItem("yaws.ai.dock")),
    );
    expect(Math.abs(storedBox.x - moved.x)).toBeLessThan(2);
    expect(Math.abs(storedBox.y - moved.y)).toBeLessThan(2);
    const grip = await page.locator(".ai-dock-resize").boundingBox();
    await page.mouse.move(grip.x + 8, grip.y + 8);
    await page.mouse.down();
    await page.mouse.move(grip.x + 88, grip.y + 68, { steps: 8 });
    await page.mouse.up();
    const resized = await dock.boundingBox();
    expect(resized.width).toBeGreaterThan(moved.width + 40);
    expect(resized.height).toBeGreaterThan(moved.height + 30);
    // Double clicking the header sends it back to its default corner.
    await page.locator(".ai-dock-head").dblclick({ position: { x: 90, y: 12 } });
    expect(await page.evaluate(() => localStorage.getItem("yaws.ai.dock"))).toBe(
      null,
    );
    await expect(dock).toBeVisible();
    await page.getByRole("button", { name: "收起 AI 助手", exact: true }).click();
    await expect(page.locator(".ai-dock")).toHaveCount(0);
    await page.getByRole("link", { name: "返回堡垒机" }).click();
    await page.getByRole("link", { name: "延迟监控", exact: true }).click();
    await page.getByRole("button", { name: "来源机器", exact: true }).click();
    await page.getByRole("option").filter({ hasText: "Fixture 2" }).click();
    await page.getByRole("button", { name: "添加监控" }).click();
    await expect(page.locator(".eg-monitors")).toContainText("Fixture 2");
    await expect(page.locator(".latency-stats")).toContainText("20.0", {
      timeout: 15000,
    });
    await page.screenshot({
      path: "test-results/ping-desktop.png",
      fullPage: true,
    });
    expect(failures).toEqual([]);
  },
);
browserTest(
  "mobile monitor and terminal fit without horizontal overflow",
  async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(f.url + "/login");
    await page.getByPlaceholder("请输入用户名").fill("fixture");
    await page.getByPlaceholder("请输入密码").fill(f.password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("link", { name: "延迟监控", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "机器出口延迟" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/ping-mobile.png",
      fullPage: true,
    });
    await page.getByRole("link", { name: "堡垒机", exact: true }).click();
    await page.getByRole("link", { name: "进入终端" }).first().click();
    await expect(page.locator(".workspace-header")).toContainText("已连接");
    // The assistant dock fits a phone screen without horizontal overflow and can
    // still be dragged out of the way of the touch key bar.
    await page.getByRole("button", { name: "AI 助手", exact: true }).click();
    await expect(page.locator(".ai-dock")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const dock = page.locator(".ai-dock");
    const phone = await dock.boundingBox();
    await page.mouse.move(phone.x + 60, phone.y + 14);
    await page.mouse.down();
    await page.mouse.move(phone.x + 40, phone.y - 90, { steps: 8 });
    await page.mouse.up();
    const lifted = await dock.boundingBox();
    expect(lifted.y).toBeLessThan(phone.y - 40);
    expect(lifted.x + lifted.width).toBeLessThanOrEqual(390);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/ai-mobile.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "收起 AI 助手", exact: true }).click();
    // In the stacked layout the divider resizes the two panes vertically.
    await page.getByRole("tab", { name: "文件", exact: true }).click();
    const splitter = page.getByRole("separator", { name: "调整终端面板比例" });
    await expect(splitter).toBeVisible();
    const paneHeight = () =>
      page.locator(".terminal-workspace").boundingBox().then((b) => b.height);
    const short = await paneHeight();
    const divider = await splitter.boundingBox();
    await page.mouse.move(divider.x + 40, divider.y + 3);
    await page.mouse.down();
    await page.mouse.move(divider.x + 40, divider.y - 90, { steps: 8 });
    await page.mouse.up();
    expect(await paneHeight()).toBeGreaterThan(short + 40);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/terminal-mobile.png",
      fullPage: true,
    });
  },
);

browserTest(
  "existing inventory selection, refresh, range and interactive chart",
  async ({ page }) => {
    const failures = [];
    page.on("pageerror", (e) => failures.push(e.message));
    f.db
      .prepare(
        "INSERT INTO machines(id,name,hostname,agent_key_hash,created_at,updated_at) VALUES (9,'Agent-only server','edge-no-ssh','hash',0,0)",
      )
      .run();
    await page.goto(f.url + "/login");
    await page.getByPlaceholder("请输入用户名").fill("fixture");
    await page.getByPlaceholder("请输入密码").fill(f.password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("link", { name: "延迟监控", exact: true }).click();
    await page.getByRole("button", { name: "新建监控", exact: true }).click();
    await page.getByRole("button", { name: "来源机器", exact: true }).click();
    await expect(
      page.getByRole("option").filter({ hasText: "Fixture 3" }),
    ).toContainText("需升级 Agent");
    await page.getByLabel("搜索已有服务器").fill("Agent-only");
    await page
      .getByRole("option")
      .filter({ hasText: "Agent-only server" })
      .click();
    await expect(page.locator(".eg-source-hint")).toContainText("离线");
    await page.getByRole("button", { name: "添加监控", exact: true }).click();
    await expect(page.locator(".eg-detail-header h2")).toContainText(
      "Agent-only server",
    );
    const monitor = f.db
      .prepare("SELECT id FROM ping_monitors WHERE machine_id=9")
      .get();
    const insert = f.db.prepare(
      "INSERT INTO ping_samples(monitor_id,at,latency_ms,error) VALUES (?,?,?,?)",
    );
    const now = Date.now();
    for (let i = 0; i < 160; i++)
      insert.run(
        monitor.id,
        now - (160 - i) * 5000,
        i === 70
          ? 180
          : i >= 90 && i < 94
            ? null
            : 28 + Math.sin(i / 10) * 7 + (i % 5),
        i === 91
          ? "agent_offline"
          : i >= 90 && i < 94
            ? "timeout_or_unreachable"
            : null,
      );
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(page.locator(".eg-stats")).toContainText("180.0");
    const chart = page.getByRole("img", {
      name: "出口延迟图，使用左右方向键查看采样详情",
    });
    await chart.focus();
    await chart.press("End");
    await expect(page.locator(".eg-tooltip")).toContainText("延迟");
    await page.screenshot({
      path: "test-results/egress-chart-desktop.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "24 小时", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "24 小时", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".eg-chart-legend")).toContainText("360 秒 / 点");
    f.db
      .prepare(
        "INSERT INTO machines(id,name,agent_key_hash,created_at,updated_at) VALUES (10,'Added after page load','hash',0,0)",
      )
      .run();
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page.getByRole("button", { name: "新建监控", exact: true }).click();
    await page.getByRole("button", { name: "来源机器", exact: true }).click();
    await expect(
      page.getByRole("option").filter({ hasText: "Added after page load" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "关闭新建监控", exact: true })
      .click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "15 分钟", exact: true }).click();
    await expect(page.locator(".eg-stats")).toContainText("180.0");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/egress-chart-mobile.png",
      fullPage: true,
    });
    const mobileChart = await chart.boundingBox();
    expect(mobileChart.width).toBeLessThan(391);
    await chart.focus(); await chart.press('End');
    const tooltip = await page.locator('.eg-tooltip').boundingBox();
    expect(tooltip.x + tooltip.width).toBeLessThan(391);
    await page.goto(f.url + '/app/ping?machineId=3');
    await expect(page.getByRole('button',{name:'来源机器',exact:true})).toContainText('Fixture 3');
    await expect(page.locator('.eg-source-hint')).toContainText('v0.2.0');
    let sourceAttempts=0;
    await page.route('**/api/ping/machines', async route=>{
      if(sourceAttempts++===0)await route.fulfill({status:503,contentType:'application/json',body:'{"error":"temporary_unavailable"}'});
      else await route.continue();
    });
    await page.reload();
    await expect(page.getByRole('alert')).toContainText('temporary_unavailable');
    await page.getByRole('button',{name:'重试加载',exact:true}).click();
    await expect(page.getByRole('button',{name:'来源机器',exact:true})).toContainText('Fixture 3');
    await expect(page.locator('.eg-inline-error')).toHaveCount(0);
    expect(failures).toEqual([]);
  },
);
