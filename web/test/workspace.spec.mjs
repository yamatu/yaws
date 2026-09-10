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
  "desktop workspace: trust, shortcuts, files, AI diff, machine Ping",
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
    await page.getByRole("button", { name: "确认并信任此指纹" }).click();
    await expect(page.locator(".workspace-header")).toContainText("已连接");
    await page.getByRole("button", { name: "添加指令", exact: true }).click();
    await page.getByLabel("指令名称").fill("健康检查");
    await page.getByLabel("指令内容").fill("uptime");
    await page
      .locator(".shortcut-form")
      .getByRole("button", { name: "保存", exact: true })
      .click();
    await expect(page.locator(".shortcut-item")).toContainText("健康检查");
    page.on("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("button", { name: "执行 健康检查", exact: true })
      .click();
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
    await page.getByRole("tab", { name: "AI", exact: true }).click();
    await page.getByLabel("API 地址", { exact: true }).fill(f.modelUrl);
    await page.getByLabel("模型", { exact: true }).fill("fixture-model");
    await page.getByLabel("推理级别", { exact: true }).fill("high");
    await page.getByLabel("API Key", { exact: true }).fill("fixture-key");
    await page.getByLabel("允许内网 / HTTP 接口", { exact: true }).check();
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await page
      .getByLabel("任务", { exact: true })
      .fill("开启配置并提供验证命令");
    await page.getByRole("button", { name: "生成修改", exact: true }).click();
    await expect(page.locator(".ai-proposal")).toHaveCount(2);
    await expect(page.locator(".diff-add")).toContainText("true");
    expect(f.files.get("/srv/app/config.json").toString()).toContain("browser");
    await page.screenshot({
      path: "test-results/ai-desktop.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "应用修改", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "已应用", exact: true }),
    ).toBeDisabled();
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
