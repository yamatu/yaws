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
/** Message rows must never be squeezed by the flex layout: a tool card that
 *  needs 31px but gets 2px both hides its text and overlaps its neighbours. */
async function expectNoSqueezedMessages(page, scope = ".ai-chat-transcript") {
  const bad = await page.evaluate((selector) => {
    return [...document.querySelectorAll(selector + " > *")]
      .filter((el) => el.scrollHeight > el.clientHeight + 1)
      .map((el) => `${el.className}:${el.clientHeight}/${el.scrollHeight}`);
  }, scope);
  expect(bad).toEqual([]);
}
browserTest(
  "desktop workspace: trust, shortcuts, files, AI chat, machine Ping",
  async ({ page }) => {
    const failures = [];
    page.on("pageerror", (error) => failures.push(error.message));
    // Seed one metric per fixture machine so the home page has something to draw:
    // idle (green), half full (yellow) and nearly full (red). Every value of a
    // machine has to land in the same band — the bands start at 50% and 70%. The
    // fixture inserts no metrics of its own, and they are removed again below so
    // the other specs still see the untouched database.
    const insertMetric = f.db.prepare(
      "INSERT INTO metrics(machine_id,at,cpu_usage,mem_used,mem_total,disk_used,disk_total,load_1,load_5,load_15) VALUES (?,?,?,?,?,?,?,0,0,0)",
    );
    const metricAt = Date.now();
    insertMetric.run(1, metricAt, 0.42, 1_500_000_000, 4_000_000_000, 8_000_000_000, 40_000_000_000);
    insertMetric.run(2, metricAt, 0.58, 2_200_000_000, 4_000_000_000, 24_000_000_000, 40_000_000_000);
    insertMetric.run(3, metricAt, 0.71, 2_900_000_000, 4_000_000_000, 39_000_000_000, 40_000_000_000);
    await page.goto(f.url + "/login");
    // The browser tab names the page that is open instead of a bare product name.
    await expect(page).toHaveTitle("登录 · YAWS");
    await page.getByPlaceholder("请输入用户名").fill("fixture");
    await page.getByPlaceholder("请输入密码").fill(f.password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    // The login is cached: the token is kept and a reload restores the session
    // instead of showing the form again.
    expect(await page.evaluate(() => !!localStorage.getItem("yaws_token"))).toBe(true);
    await page.reload();
    await expect(page.getByRole("button", { name: "退出", exact: true })).toBeVisible();
    await expect(page.getByPlaceholder("请输入密码")).toHaveCount(0);
    await expect(page).toHaveTitle("控制台 · YAWS");
    // The home page meters must pick their colour from the load (green → yellow
    // → red, i.e. yellow from 50% and red from 70%) and look like frosted glass,
    // instead of painting every bar with the same fixed rainbow gradient.
    const metersOf = (id) =>
      page
        .locator(".yaws-card")
        .filter({ hasText: `Fixture ${id}` })
        .first()
        .locator(".yaws-meter");
    await expect(metersOf(1)).toHaveCount(3);
    for (const n of [0, 1, 2]) {
      await expect(metersOf(1).nth(n)).toHaveClass(/level-ok/);
      await expect(metersOf(2).nth(n)).toHaveClass(/level-warn/);
      await expect(metersOf(3).nth(n)).toHaveClass(/level-high/);
    }
    const readMeter = (locator) =>
      locator.evaluate((el) => {
        const track = getComputedStyle(el);
        const fill = getComputedStyle(el.firstElementChild);
        return {
          from: track.getPropertyValue("--meter-from").trim(),
          mid: track.getPropertyValue("--meter-mid").trim(),
          to: track.getPropertyValue("--meter-to").trim(),
          track: track.backgroundColor,
          trackBlur: track.backdropFilter,
          fillBlur: fill.backdropFilter,
          fillImage: fill.backgroundImage,
          fillWidth: fill.width,
          trackWidth: track.width,
        };
      });
    const [low, mid, high] = [
      await readMeter(metersOf(1).nth(2)),
      await readMeter(metersOf(2).nth(2)),
      await readMeter(metersOf(3).nth(2)),
    ];
    // One hue per level, named by CSS variables so tests never depend on how the
    // gradient itself is serialised. Yellow starts at 50%, red at 70%.
    expect(low.from).toBe("#86efac");
    expect(low.mid).toBe("#34d399");
    expect(low.to).toBe("#059669");
    expect(mid.from).toBe("#fde68a");
    expect(mid.mid).toBe("#fbbf24");
    expect(mid.to).toBe("#d97706");
    expect(high.from).toBe("#fecdd3");
    expect(high.mid).toBe("#fb7185");
    expect(high.to).toBe("#dc2626");
    // Each fill is a translucent white sheen over a light→base→deep gradient of
    // one hue, so the colour still changes in the middle of the bar. Green must
    // not contain the amber/cyan stops of the old rainbow.
    expect(low.fillImage).toContain("rgba(255, 255, 255");
    expect(low.fillImage).toContain("rgb(134, 239, 172)");
    expect(low.fillImage).toContain("rgb(52, 211, 153)");
    expect(low.fillImage).toContain("rgb(5, 150, 105)");
    expect(low.fillImage).not.toContain("56, 189, 248");
    expect(low.fillImage).not.toContain("251, 191, 36");
    expect(mid.fillImage).toContain("rgb(253, 230, 138)");
    expect(mid.fillImage).toContain("rgb(251, 191, 36)");
    expect(mid.fillImage).toContain("rgb(217, 119, 6)");
    expect(high.fillImage).toContain("rgb(254, 205, 211)");
    expect(high.fillImage).toContain("rgb(251, 113, 133)");
    expect(high.fillImage).toContain("rgb(220, 38, 38)");
    // Frosted glass on both the track and the fill.
    expect(low.trackBlur).toContain("blur(");
    expect(high.fillBlur).toContain("blur(");
    // A high load also tints its own track, so the alert reads early.
    expect(high.track).not.toBe(low.track);
    // The bar is still exactly as wide as the load it represents (disk 8/40 GB).
    expect(parseFloat(low.fillWidth)).toBeCloseTo(parseFloat(low.trackWidth) * 0.2, 0);
    // Numbers carry the level colour and the bar is announced to screen readers.
    await expect(
      page.locator(".yaws-meter-value.level-high").first(),
    ).toHaveCSS("color", "rgb(252, 165, 165)");
    await expect(metersOf(1).nth(0)).toHaveAttribute("role", "progressbar");
    await expect(metersOf(1).nth(0)).toHaveAttribute("aria-valuenow", "42");
    await expect(metersOf(1).nth(0)).toHaveAttribute("aria-valuetext", "42%");
    await page.screenshot({
      path: "test-results/usage-meters.png",
      fullPage: true,
    });
    // The percentages added next to the bars must not push the cards sideways on a
    // phone, where the meter rows are the widest content of a card.
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    expect(
      await page.locator(".yaws-meter").first().evaluate(
        (el) => el.getBoundingClientRect().right <= innerWidth,
      ),
    ).toBe(true);
    await page.setViewportSize({ width: 1280, height: 720 });
    f.db.prepare("DELETE FROM metrics").run();
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
    // The shortcut list starts folded; the resource panel keeps its space. The
    // internal-host list shares the toggle style, so the picker names the one
    // in question.
    const shortcutToggle = page.getByRole("button", { name: "快捷指令" });
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
    // Both mount points (/ at 78% and /data at 94%) are past the 70% mark.
    await expect(stats.locator(".stat-bar-fill.level-high")).toHaveCount(2);
    // cpu (33%) and swap stay below the 50% mark, memory (69%) does not.
    await expect(stats.locator(".stat-bar-fill.level-ok")).toHaveCount(2);
    await expect(stats.locator(".stat-value.level-warn").first()).toHaveCSS(
      "color",
      "rgb(252, 211, 77)",
    );
    // The workspace panel shares the meter palette: green / yellow / red with the
    // same frosted glass fill and light→base→deep gradient as the home page.
    expect(
      await stats.locator(".stat-bar-fill.level-ok").first().evaluate((el) => ({
        from: getComputedStyle(el).getPropertyValue("--meter-from").trim(),
        mid: getComputedStyle(el).getPropertyValue("--meter-mid").trim(),
        image: getComputedStyle(el).backgroundImage,
        blur: getComputedStyle(el).backdropFilter,
      })),
    ).toEqual({
      from: "#86efac",
      mid: "#34d399",
      image: expect.stringContaining("rgb(52, 211, 153)"),
      blur: expect.stringContaining("blur("),
    });
    await expect(
      stats.locator(".stat-value.level-high").first(),
    ).toHaveCSS("color", "rgb(252, 165, 165)");
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
      // Long enough to scroll, so the remembered scroll offset can be checked.
      buffer: Buffer.from(
        `${Array.from(
          { length: 200 },
          (_, i) => `line ${String(i + 1).padStart(3, "0")}`,
        ).join("\n")}\n`,
      ),
    });
    await expect(page.locator(".file-list")).toContainText(
      "browser-upload.txt",
    );
    // Opening a file remembers the directory, the file, the caret and the scroll
    // offset, so a long file can be picked up exactly where it was left.
    await page
      .getByRole("button", { name: "browser-upload.txt", exact: true })
      .click();
    // Wait for the editor to hold the new file before touching it: switching files
    // mounts a fresh editor, and a keystroke sent to the old one is thrown away.
    await expect(page.locator(".cm-content")).toContainText("line 001");
    await page.locator(".cm-scroller").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const targetLine = page.locator(".cm-line").filter({ hasText: "line 180" });
    await targetLine.click();
    await page.waitForFunction(
      () => {
        const raw = localStorage.getItem("yaws.workspace.cursor.1");
        if (!raw) return false;
        const state = JSON.parse(raw)["/srv/app/browser-upload.txt"];
        return Boolean(state) && state.scrollTop > 0;
      },
      null,
      { timeout: 5000 },
    );
    expect(await page.evaluate(() => localStorage.getItem("yaws.ssh.tab.1"))).toBe(
      "files",
    );
    expect(
      await page.evaluate(() => localStorage.getItem("yaws.workspace.view.1")),
    ).toContain("/srv/app/browser-upload.txt");
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
    await page.getByLabel("问题").fill("[slow][pre][run] 看一下磁盘");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    // The status line describes the whole run, not just the last tool call.
    const status = page.locator(".ai-chat-working");
    await expect(status).toContainText("第 1 步 · 正在思考…");
    await expect(page.locator(".ai-bubble")).toContainText("[slow][pre][run] 看一下磁盘");
    await expect(page.locator(".ai-tool")).toContainText("df -h /");
    await expect(page.locator(".ai-tool-state")).toContainText("完成");
    // A finished step is not a finished answer: the status line keeps counting
    // the run's steps rather than only describing the newest tool call. The
    // fixture model answers in a few milliseconds, so the intermediate wording
    // is not reliably observable; what is asserted is that the step is counted
    // in the run's own tally by the time it ends.
    await expect(status).toContainText("共 2 个步骤");
    await expect(page.locator(".ai-answer")).toContainText(
      "已生成配置修改与验证命令。",
    );
    // Only the end of the stream reports a finished run, together with its time.
    await expect(status).toContainText("已完成 · 用时");
    // The model streamed a sentence before it called the tool, so the assistant
    // entry was created first — the transcript still lists the finished step
    // above the answer, and the answer closes the turn.
    expect(
      await page.locator(".ai-chat-transcript").evaluate((node) => {
        const tool = node.querySelector(".ai-tool");
        const answer = node.querySelector(".ai-row.answer");
        if (!tool || !answer) return false;
        return (
          node.lastElementChild === answer &&
          answer.getBoundingClientRect().top > tool.getBoundingClientRect().bottom
        );
      }),
    ).toBe(true);
    // Reading back must survive the stream: a step arriving while the operator
    // is away from the end must not steal the view, and the arrow brings them
    // back to the newest content (and only then appears).
    await page.getByLabel("问题").fill("[run] 继续检查磁盘");
    await page.getByRole("button", { name: "发送" }).click();
    await expect(page.locator(".ai-chat-jump")).toHaveCount(0);
    await page.locator(".ai-chat-transcript").evaluate((node) => {
      node.scrollTop = 0;
      node.dispatchEvent(new Event("scroll"));
    });
    await expect(page.locator(".ai-chat-jump")).toBeVisible();
    const held = await page.locator(".ai-chat-transcript").evaluate((node) => ({
      top: node.scrollTop,
      bottom: node.scrollHeight - node.scrollTop - node.clientHeight,
    }));
    expect(held.top).toBeLessThanOrEqual(1);
    expect(held.bottom).toBeGreaterThan(0);
    // A token arriving while the operator reads back leaves the position alone.
    await expect(page.locator(".ai-answer").last()).toContainText(
      "已生成配置修改与验证命令。",
    );
    expect(
      await page.locator(".ai-chat-transcript").evaluate((node) => node.scrollTop),
    ).toBeLessThanOrEqual(1);
    // The arrow jumps to the end, which also resumes following.
    await page.locator(".ai-chat-jump").click();
    await expect(page.locator(".ai-chat-jump")).toHaveCount(0);
    expect(
      await page.locator(".ai-chat-transcript").evaluate(
        (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
      ),
    ).toBeLessThanOrEqual(24);
    // Each configuration carries its own API key.
    expect(f.modelRequests.at(-1).headers.authorization).toBe(
      "Bearer fixture-key",
    );
    await expect(page.locator(".ai-chat-session")).toContainText("主力模型");
    // The arrow keys recall the questions this conversation was already asked,
    // newest first, and coming back down returns the half-written question
    // instead of clearing it.
    const question = page.getByLabel("问题");
    await question.fill("[run] 稍后再问的问题");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".ai-answer").last()).toContainText(
      "已生成配置修改与验证命令。",
    );
    await question.fill("还没写完的问题");
    // The question just asked is the first thing `up` reaches.
    await question.press("ArrowUp");
    await expect(question).toHaveValue("[run] 稍后再问的问题");
    // A second press goes one older, and the value is one of the questions this
    // conversation was asked before — not the draft and not the newest.
    await question.press("ArrowUp");
    const older = await question.inputValue();
    expect(older).not.toBe("[run] 稍后再问的问题");
    expect(older).not.toBe("还没写完的问题");
    expect(older.trim()).not.toBe("");
    // Coming back down returns the newest question, then the draft.
    await question.press("ArrowDown");
    await expect(question).toHaveValue("[run] 稍后再问的问题");
    await question.press("ArrowDown");
    await expect(question).toHaveValue("还没写完的问题");
    // Walk to the oldest question and confirm `up` there does not swallow the key
    // (the box keeps its value instead of going blank).
    for (let i = 0; i < 20; i += 1) await question.press("ArrowUp");
    await expect(question).not.toHaveValue("");
    // Editing a recalled question makes it the operator's own text, so the next
    // arrow press must not silently throw the edit away.
    await question.fill("改过的草稿");
    await question.press("ArrowUp");
    const recalled = await question.inputValue();
    expect(recalled).not.toBe("改过的草稿");
    await question.press("ArrowDown");
    await expect(question).toHaveValue("改过的草稿");
    // In a multi-line question the arrows first move the caret through the text,
    // so recall only takes over once the caret reaches the edge. A caret in the
    // middle of the text keeps the key for editing.
    await question.fill("第一行\n第二行\n第三行");
    await question.evaluate((node) => node.setSelectionRange(5, 5));
    await question.press("ArrowUp");
    await expect(question).toHaveValue("第一行\n第二行\n第三行");
    await question.press("ArrowDown");
    await expect(question).toHaveValue("第一行\n第二行\n第三行");
    // Caret on the last line: nothing left below, so `down` walks back to the
    // draft. Walking up first is what makes there be anything to walk down to.
    await question.evaluate((node) => node.setSelectionRange(0, 0));
    await question.press("ArrowUp");
    await expect(question).not.toHaveValue("第一行\n第二行\n第三行");
    const recalledMulti = await question.inputValue();
    await question.evaluate((node) => {
      node.setSelectionRange(node.value.length, node.value.length);
    });
    await question.press("ArrowDown");
    await expect(question).toHaveValue("第一行\n第二行\n第三行");
    expect(recalledMulti).not.toBe("第一行\n第二行\n第三行");
    await question.fill("");
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
    await expectNoSqueezedMessages(page);
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
    // Four questions were asked by this point, the last one for the recall check.
    await expect(page.locator(".ai-conv-row").first()).toContainText("4 轮");
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
    // Answers render as Markdown: headings, emphasis, lists, quotes, code, tables, links.
    await page.getByLabel("问题").fill("[md] 用 markdown 总结磁盘");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const answer = page.locator(".ai-answer").last();
    await expect(answer.locator("h2")).toHaveText("磁盘排查结论");
    await expect(answer.locator("strong").first()).toHaveText("78%");
    await expect(answer.locator("del")).toHaveText("90%");
    await expect(answer.locator(".ai-md-code").first()).toHaveText("/");
    await expect(answer.locator("ol li")).toHaveCount(2);
    await expect(answer.locator("ul.ai-md-tasks li")).toHaveCount(2);
    await expect(answer.locator(".ai-md-check.on")).toHaveCount(1);
    await expect(answer.locator("blockquote")).toContainText("删除前请先备份。");
    await expect(answer.locator(".ai-code-lang")).toHaveText("Shell");
    await expect(answer.locator(".ai-code pre code")).toContainText(
      "journalctl --vacuum-size=200M",
    );
    const rows = answer.locator("table tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1).locator("td").nth(1)).toHaveText("94%");
    expect(
      await rows
        .nth(1)
        .locator("td")
        .nth(1)
        .evaluate((cell) => getComputedStyle(cell).textAlign),
    ).toBe("right");
    await expect(answer.locator("table thead th").first()).toHaveText("分区");
    const mdLink = answer.locator("a");
    await expect(mdLink).toHaveAttribute("href", "https://example.com/disk");
    await expect(mdLink).toHaveAttribute("rel", /noreferrer/);
    expect(await mdLink.evaluate((node) => node.target)).toBe("_blank");
    // Copying a block works without clipboard permissions (textarea fallback).
    const copy = answer.locator(".ai-code-copy");
    await copy.click();
    await expect(copy).toContainText("已复制");
    await expectNoSqueezedMessages(page);
    // Raw HTML inside an answer is text, never markup.
    expect(
      await answer.evaluate((node) => node.querySelector("script,img") === null),
    ).toBe(true);
    await page.screenshot({ path: "test-results/ai-markdown.png", fullPage: true });
    // The same assistant floats over the terminal as an add-on panel.
    await page.getByRole("tab", { name: "终端", exact: true }).click();
    await page.getByRole("button", { name: "AI 助手", exact: true }).click();
    await expect(page.locator(".ai-dock")).toBeVisible();
    await expect(page.locator(".ai-dock .ai-chat-transcript")).toContainText(
      "看一下磁盘",
    );
    await expect(page.locator(".ai-dock .ai-answer").last()).toContainText(
      "磁盘排查结论",
    );
    await expectNoSqueezedMessages(page, ".ai-dock .ai-chat-transcript");
    // A wide table or code block scrolls inside the narrow panel instead of
    // stretching it — no page-level horizontal overflow.
    const dockOverflow = await page.evaluate(() => {
      const el = document.querySelector(".ai-dock .ai-chat-transcript");
      return {
        panel: el.scrollWidth - el.clientWidth,
        page: document.documentElement.scrollWidth - innerWidth,
      };
    });
    expect(dockOverflow.panel).toBeLessThanOrEqual(1);
    expect(dockOverflow.page).toBeLessThanOrEqual(1);
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
    // Even at its smallest size the transcript keeps room for the messages: the
    // panel stops at its own minimum height (see `dockBox.MIN_DOCK_H`), so the
    // scroller only gives up the header and the composer row.
    const small = await page.locator(".ai-dock-resize").boundingBox();
    await page.mouse.move(small.x + 8, small.y + 8);
    await page.mouse.down();
    await page.mouse.move(small.x - 600, small.y - 600, { steps: 8 });
    await page.mouse.up();
    const shrunk = await dock.boundingBox();
    expect(shrunk.width).toBeLessThan(resized.width);
    expect(shrunk.height).toBeLessThan(resized.height);
    await expectNoSqueezedMessages(page, ".ai-dock .ai-chat-transcript");
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
    // Coming back to the same machine restores the tab, the file and the caret,
    // so an edit can be continued exactly where it was left off.
    await page.goto(f.url + "/app/machines/1/ssh");
    await expect(page.locator(".workspace-header")).toContainText("已连接");
    // The last tab of this machine comes back: the SSH part was used last.
    await expect(
      page.getByRole("tab", { name: "终端", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "文件", exact: true }).click();
    await expect(page.locator(".cm-activeLine")).toContainText("line 180");
    expect(
      await page.locator(".cm-scroller").evaluate((el) => el.scrollTop),
    ).toBeGreaterThan(0);
    await page.goto(f.url + "/app/machines/1/ssh");
    await expect(
      page.getByRole("tab", { name: "文件", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".file-editor-pane")).toContainText(
      "browser-upload.txt",
    );
    await expect(page.locator(".cm-activeLine")).toContainText("line 180");
    expect(
      await page.locator(".cm-scroller").evaluate((el) => el.scrollTop),
    ).toBeGreaterThan(0);
    await expect(page).toHaveTitle("Fixture 1 · YAWS");
    // Signing out clears the cached login, and the form still offers the
    // remembered username so only the password is left to type.
    await page.goto(f.url + "/app");
    await page.getByRole("button", { name: "退出", exact: true }).click();
    await expect(page.getByPlaceholder("请输入用户名")).toHaveValue("fixture");
    await expect(page.getByPlaceholder("请输入密码")).toHaveValue("");
    expect(await page.evaluate(() => localStorage.getItem("yaws_token"))).toBe(null);
    // An expired session says why it came back to the form.
    await page.goto(f.url + "/login?expired=1");
    await expect(page.locator(".yaws-alert-error")).toContainText(
      "登录状态已过期",
    );
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
    // The tab title follows the page that is open.
    await expect(page).toHaveTitle("延迟监控 · YAWS");
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
    // Trust the host key unless the desktop spec already did, so this spec also
    // passes when it is run on its own.
    const fingerprint = f.db
      .prepare("SELECT ssh_host_fingerprint as fp FROM machines WHERE id=1")
      .get().fp;
    if (!fingerprint) {
      await page
        .getByRole("button", { name: "读取主机指纹", exact: true })
        .click();
      await page.getByRole("button", { name: "确认并信任此指纹" }).click();
    }
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

browserTest(
  "several terminals run side by side and keep their own AI context",
  async ({ page }) => {
    const failures = [];
    page.on("pageerror", (e) => failures.push(e.message));
    await page.goto(f.url + "/login");
    await page.getByPlaceholder("请输入用户名").fill("fixture");
    await page.getByPlaceholder("请输入密码").fill(f.password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    // One model profile is enough: this test is about where each answer lands.
    await page.evaluate(async (baseUrl) => {
      const token = localStorage.getItem("yaws_token");
      await fetch("/api/ai/profiles", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          activeId: "multi",
          profiles: [
            {
              id: "multi",
              name: "多终端模型",
              baseUrl,
              protocol: "chat",
              model: "fixture-model",
              reasoning: "",
              apiKey: "fixture-key",
              allowPrivate: true,
            },
          ],
        }),
      });
    }, f.modelUrl);
    // Only the active pane is rendered, so every query is scoped to it.
    const visible = page.locator(".remote-workspace:not([hidden])");
    const chip = (name) => page.locator(".ssh-session").filter({ hasText: name });

    // An already trusted server must not ask again: this spec also runs after the
    // desktop spec, which trusts Fixture 1.
    const knowsKey = (id) =>
      !!f.db
        .prepare("SELECT ssh_host_fingerprint as fp FROM machines WHERE id=?")
        .get(id).fp;
    const trust = async (id) => {
      if (knowsKey(id)) return;
      await visible
        .getByRole("button", { name: "读取主机指纹", exact: true })
        .click();
      await visible.getByRole("button", { name: "确认并信任此指纹" }).click();
    };
    await page.goto(f.url + "/app/machines/1/ssh");
    await trust(1);
    await expect(visible.locator(".workspace-header")).toContainText("已连接");
    // Session one asks the assistant something worth remembering. The slow
    // marker leaves time to read the live status, and to stop a run halfway.
    await visible.getByRole("tab", { name: "AI", exact: true }).click();
    await visible.getByLabel("问题").fill("[slow][run] 看一下磁盘");
    await visible.getByRole("button", { name: "发送", exact: true }).click();
    const live = visible.locator(".ai-chat-working");
    await expect(live).toContainText("第 1 步 · 正在思考…");
    await expect(visible.locator(".ai-answer").last()).toContainText(
      "已生成配置修改与验证命令。",
    );
    await expect(live).toContainText("已完成 · 用时");
    await expect(live).toHaveAttribute("data-tone", "ok");
    // Cancelling is its own outcome, not a finished answer.
    await visible.getByLabel("问题").fill("[slow][run] 再看一次磁盘");
    await visible.getByRole("button", { name: "发送", exact: true }).click();
    await expect(live).toContainText("正在思考");
    await visible.getByRole("button", { name: "停止", exact: true }).click();
    await expect(live).toContainText("已停止 · 用时");
    await expect(visible.locator(".ai-chat .yaws-alert-error")).toContainText("已停止");
    // A second server joins from the strip without leaving the page.
    await page
      .getByRole("button", { name: "打开其他服务器的终端", exact: true })
      .click();
    const picker = page.getByRole("dialog", { name: "选择服务器" });
    await expect(picker).toBeVisible();
    await expect(
      picker.locator(".ssh-picker-item").filter({ hasText: "Fixture 1" }),
    ).toContainText("已打开");
    await picker
      .locator(".ssh-picker-item")
      .filter({ hasText: "Fixture 2" })
      .click();
    await expect(picker).toHaveCount(0);
    await expect(chip("Fixture 2")).toHaveCount(1);
await expect(page.locator(".ssh-session")).toHaveCount(2);
    await trust(2);
    await expect(visible.locator(".workspace-header")).toContainText("Fixture 2");
    await expect(visible.locator(".workspace-header")).toContainText("已连接");
    // The second terminal has its own empty assistant: no context leaks across
    // servers, which is exactly what broke when several terminals were open.
    await visible.getByRole("tab", { name: "AI", exact: true }).click();
    await expect(visible.locator(".ai-chat-empty")).toBeVisible();
    await expect(visible.locator(".ai-answer")).toHaveCount(0);
    // The background terminal is still mounted: its transcript is in the DOM
    // (behind the hidden pane) instead of being thrown away on every switch.
    await expect(
      page.locator(".remote-workspace[hidden] .ai-answer").last(),
    ).toContainText("已生成配置修改与验证命令。");
    await expect(page.locator(".remote-workspace[hidden] .xterm")).toHaveCount(1);
    // Going back to the first terminal keeps its transcript, its tab and its
    // live connection — the background session was never torn down.
    await chip("Fixture 1").getByRole("tab").click();
    await expect(visible.locator(".workspace-header")).toContainText("Fixture 1");
    await expect(visible.locator(".ai-answer").last()).toContainText(
      "已生成配置修改与验证命令。",
    );
    await expect(chip("Fixture 1").locator(".bg-emerald-400")).toHaveCount(1);
    await expect(chip("Fixture 2").locator(".bg-emerald-400")).toHaveCount(1);
    await page.screenshot({
      path: "test-results/terminals-desktop.png",
      fullPage: true,
    });
    // Closing the background terminal leaves the visible one untouched.
    await page
      .getByRole("button", { name: "关闭 Fixture 2 的终端", exact: true })
      .click();
    await expect(page.locator(".ssh-session")).toHaveCount(1);
    await expect(visible.locator(".workspace-header")).toContainText("Fixture 1");
    // The open set survives a reload, together with the conversation.
    await page.reload();
    await expect(page.locator(".ssh-session")).toHaveCount(1);
    await expect(visible.locator(".workspace-header")).toContainText("Fixture 1");
    await expect(visible.locator(".workspace-header")).toContainText("已连接");
    await expect(visible.locator(".ai-answer").last()).toContainText(
      "已生成配置修改与验证命令。",
    );
    // A server whose key is already known must not flash the trust prompt while
    // its key is being re-checked: the collapsing button used to swallow clicks.
    await page.route("**/workspace/host-key", async (route) => {
      await new Promise((done) => setTimeout(done, 700));
      await route.continue();
    });
    await page.reload();
    await page.waitForTimeout(250);
    const flashed = await page.locator(".host-key-prompt").count();
    await expect(visible.locator(".workspace-header")).toContainText("已连接");
    await page.unroute("**/workspace/host-key");
    expect(flashed).toBe(0);
    // Everything else can be opened in one go and stays in the background.
    await page
      .getByRole("button", { name: "打开其他服务器的终端", exact: true })
      .click();
    await page
      .getByRole("button", { name: /打开全部可连接的服务器/ })
      .click();
    await expect(page.locator(".ssh-session")).toHaveCount(3);
    await expect(page.locator(".remote-workspace")).toHaveCount(3);
    await expect(page.locator(".remote-workspace:not([hidden])")).toHaveCount(1);
    // The bulk open lands on the first new server, which was trusted earlier.
    await expect(visible.locator(".workspace-header")).toContainText("Fixture 2");
    await expect(visible.locator(".workspace-header")).toContainText("已连接");
    // The last server still has to be trusted, and only then does its dot go green.
    await chip("Fixture 3").getByRole("tab").click();
    await trust(3);
    await expect(visible.locator(".workspace-header")).toContainText("Fixture 3");
    await expect(visible.locator(".workspace-header")).toContainText("已连接");
    for (const name of ["Fixture 1", "Fixture 2", "Fixture 3"])
      await expect(chip(name).locator(".bg-emerald-400")).toHaveCount(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(failures).toEqual([]);
  },
);

browserTest(
  "an answer that was running survives leaving the page",
  async ({ page }) => {
    const failures = [];
    page.on("pageerror", (e) => failures.push(e.message));
    await page.goto(f.url + "/login");
    await page.getByPlaceholder("请输入用户名").fill("fixture");
    await page.getByPlaceholder("请输入密码").fill(f.password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.evaluate(async (baseUrl) => {
      const token = localStorage.getItem("yaws_token");
      await fetch("/api/ai/profiles", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          activeId: "recovery",
          profiles: [
            {
              id: "recovery",
              name: "恢复模型",
              baseUrl,
              protocol: "chat",
              model: "fixture-model",
              reasoning: "",
              apiKey: "fixture-key",
              allowPrivate: true,
            },
          ],
        }),
      });
    }, f.modelUrl);
    const visible = page.locator(".remote-workspace:not([hidden])");
    await page.goto(f.url + "/app/machines/1/ssh");
    const knowsKey = !!f.db
      .prepare("SELECT ssh_host_fingerprint as fp FROM machines WHERE id=1")
      .get().fp;
    if (!knowsKey) {
      await visible
        .getByRole("button", { name: "读取主机指纹", exact: true })
        .click();
      await visible.getByRole("button", { name: "确认并信任此指纹" }).click();
    }
    await expect(visible.locator(".workspace-header")).toContainText("已连接");
    await page.getByRole("tab", { name: "AI", exact: true }).click();
    await page.getByLabel("问题").fill("[slow][pre][run] 恢复测试");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    // The model streams a sentence, then runs the command. Leaving now drops
    // the stream mid-answer, which is what used to wipe the text and leave only
    // the step cards behind.
    await expect(page.locator(".ai-tool")).toContainText("df -h /");
    await page.reload();
    await page.getByRole("tab", { name: "AI", exact: true }).click();
    await expect(page.locator(".ai-answer").last()).toContainText(
      "我先看一下磁盘占用。",
    );
    await expect(page.locator(".ai-tool")).toContainText("df -h /");
    // The reload only dropped the reader: the run finished on its own, so the
    // page that came back re-attached and is asked to show the finished answer
    // rather than a transcript frozen at the moment of the refresh. Without the
    // detach this is where the turn would have been recorded as cancelled.
    await expect(page.locator(".ai-answer").last()).toContainText(
      "已生成配置修改与验证命令",
    );
    // The status line reports the finished run (with its duration) rather than
    // the "still working" phrasing, and the composer is usable again — so the
    // page that came back is looking at a completed turn, not a frozen one.
    await expect(page.locator(".ai-chat-working")).toContainText("已完成 · 用时");
    await expect(page.locator(".ai-chat-working")).not.toContainText("正在");
    await expect(
      page.getByRole("button", { name: "发送", exact: true }),
    ).toBeVisible();
    expect(failures).toEqual([]);
  },
);

// The OAuth exchange itself is integration-tested against an injected local
// provider on the server. Here the browser only mocks those API responses: no
// test should open a real login page or touch a third-party account.
browserTest("official model login can be completed in the model panel", async ({ page }) => {
  let authorized = false;
  const native = {
    id: "openai-codex", name: "OpenAI Codex",
    baseUrl: "https://chatgpt.com/backend-api",
    models: [{ id: "gpt-5.3-codex", name: "GPT Codex" }],
  };
  await page.route("**/api/ai/official/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const response = path.endsWith("/providers")
      ? { providers: [{ ...native, connected: authorized }] }
      : path.endsWith("/login") && route.request().method() === "POST"
        ? { loginId: "fake-login-id" }
        : path.endsWith("/fake-login-id") && route.request().method() === "GET"
          ? authorized
            ? { status: "done", provider: native.id, event: null, authEvent: null }
            : { status: "running", provider: native.id, event: null,
              authEvent: { type: "device_code", userCode: "TEST-CODE",
                verificationUri: "https://auth.example.test/device" } }
          : { ok: true };
    await route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify(response) });
  });
  await page.goto(f.url + "/login");
  await page.getByPlaceholder("请输入用户名").fill("fixture");
  await page.getByPlaceholder("请输入密码").fill(f.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.goto(f.url + "/app/machines/1/ssh");
  await page.getByRole("tab", { name: "AI", exact: true }).click();
  await page.getByRole("button", { name: "AI 设置", exact: true }).click();
  const panel = page.locator(".ai-official");
  await expect(panel.getByText("登录官方模型（pi 授权）")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 760 });
  expect(await panel.evaluate((node) => node.scrollWidth - node.clientWidth))
    .toBeLessThanOrEqual(1);
  await panel.getByRole("button", { name: "登录官方账号" }).click();
  await expect(panel.getByText("TEST-CODE")).toBeVisible();
  await expect(panel.getByRole("link", { name: /打开官方授权页面/ }))
    .toHaveAttribute("href", "https://auth.example.test/device");
  // A reload does not abandon the authorization attempt; the login id stays
  // in this tab's session storage and the new page resumes polling it.
  await page.reload();
  await page.getByRole("tab", { name: "AI", exact: true }).click();
  await page.getByRole("button", { name: "AI 设置", exact: true }).click();
  await expect(panel.getByText("TEST-CODE")).toBeVisible();
  authorized = true;
  await expect(panel.getByRole("button", { name: "添加到模型配置（然后保存）" }))
    .toBeVisible();
  await panel.getByRole("button", { name: "添加到模型配置（然后保存）" }).click();
  await expect(page.locator(".ai-profiles input[readonly]").first())
    .toHaveValue(native.baseUrl);
  await page.getByRole("button", { name: "保存全部配置" }).click();
  await expect(page.getByRole("button", { name: "AI 设置", exact: true }))
    .toBeVisible();
  const saved = f.db.prepare("SELECT value FROM settings WHERE key='ai_profiles_enc'").get();
  expect(saved?.value).toBeTruthy();
});
