import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { harness } from "./fixture.mjs";
import {
  ExtensionManager,
  expandExtensionPrompt,
  extensionId,
  extensionToolName,
  parseExtensionSource,
  writeExtensionPackages,
} from "../dist/extensions.js";
import { openDb } from "../dist/db.js";
import { decryptText } from "../dist/crypto.js";

const SECRET = "fixture-only-secret-123456789";

/** A temp directory that is removed when the test file finishes. */
function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `yaws-${name}-`));
}

const roots = [];
function scratch(name) {
  const dir = tempDir(name);
  roots.push(dir);
  return dir;
}
process.on("exit", () => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

/** Writes a package on disk and returns its directory. */
function writePackage(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

const DEMO_EXTENSION = `
export function activate(api) {
  api.log("demo extension loaded");
  api.registerPromptNote("扩展提示：改动前先确认备份。");
  api.registerTool({
    name: "ext_echo",
    title: "回声",
    description: "复读传入的文本，用来验证扩展工具已挂载。",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    readOnly: true,
    run: (args, ctx) => \`echo:\${args.text ?? ""}@\${ctx.packageName}\`,
  });
  api.registerTool({
    name: "ext_boom",
    description: "危险操作，由扩展自带的守卫拦截。",
    run: () => "should never run",
  });
  api.registerTool({
    name: "ext_fail",
    description: "总是失败的工具。",
    run: () => {
      throw new Error("ext_fail_exploded");
    },
  });
  api.registerSkill({
    name: "code-skill",
    description: "代码里注册的技能",
    content: "先看 dmesg。",
  });
  api.registerPrompt({
    name: "code-prompt",
    description: "代码里注册的模板",
    content: "请检查服务日志里的报错：{{ args }}",
  });
  api.on("tool_call", (event) => {
    // A guard that throws must not be able to break the whole turn.
    if (event.name === "read_skill") throw new Error("guard_is_angry");
    return event.name.includes("ext_boom")
      ? { block: true, reason: "扩展策略：禁止磁盘清理" }
      : undefined;
  });
}
`;

const DEMO_FILES = {
  "package.json": JSON.stringify({
    name: "demo-ext",
    yaws: {
      extensions: ["./extensions"],
      skills: ["./skills"],
      prompts: ["./prompts"],
    },
  }),
  "extensions/index.mjs": DEMO_EXTENSION,
  "skills/disk-check/SKILL.md":
    "---\nname: disk-check\ndescription: 磁盘排查流程\n---\n\n先跑 df -h，再跑 du -sh /*。\n",
  "prompts/triage.md": "---\ndescription: 排查模板\n---\n\n请排查以下问题并给出结论：$ARGUMENTS\n",
};

/** An extension file that throws while loading. */
const BROKEN_FILES = {
  "package.json": JSON.stringify({ name: "broken-ext", yaws: { extensions: ["./extensions"] } }),
  "extensions/index.mjs": 'throw new Error("broken_extension_on_purpose");\n',
};

test("extension sources", async (t) => {
  await t.test("accepts local paths, npm specs and git urls", () => {
    assert.deepEqual(parseExtensionSource("/srv/pkgs/demo"), {
      kind: "local",
      dir: "/srv/pkgs/demo",
    });
    assert.deepEqual(parseExtensionSource("npm:@scope/demo@1.2.3"), {
      kind: "npm",
      spec: "@scope/demo@1.2.3",
      name: "@scope/demo",
    });
    assert.deepEqual(parseExtensionSource("npm:demo"), {
      kind: "npm",
      spec: "demo",
      name: "demo",
    });
    assert.deepEqual(parseExtensionSource("git:github.com/user/repo@v1"), {
      kind: "git",
      url: "github.com/user/repo",
      ref: "v1",
    });
    assert.deepEqual(parseExtensionSource("https://github.com/user/repo"), {
      kind: "git",
      url: "https://github.com/user/repo",
      ref: "",
    });
  });

  await t.test("rejects specs that could reach the shell", () => {
    for (const source of ["", "   ", "npm:--evil", "npm:a;rm -rf /", "git:github.com/a b"])
      assert.throws(() => parseExtensionSource(source), /extension_source_invalid/);
  });

  await t.test("ids and tool names are stable and namespaced", () => {
    assert.equal(extensionId("/srv/pkgs/demo"), extensionId("/srv/pkgs/demo"));
    assert.notEqual(extensionId("/srv/pkgs/demo"), extensionId("/srv/pkgs/other"));
    const name = extensionToolName("ext_abcd1234", "ext_echo");
    assert.equal(name, "ext__ext_abcd1234__ext_echo");
    assert.ok(extensionToolName("ext_" + "x".repeat(40), "y".repeat(40)).length <= 64);
  });

  await t.test("prompt templates expand only on an exact match", () => {
    const prompts = [{ name: "triage", content: "请排查：$ARGUMENTS" }];
    assert.equal(expandExtensionPrompt(prompts, "/triage 磁盘满了"), "请排查：磁盘满了");
    assert.equal(expandExtensionPrompt(prompts, " /triage  磁盘满了 "), "请排查：磁盘满了");
    assert.equal(expandExtensionPrompt(prompts, "/unknown 磁盘满了"), "/unknown 磁盘满了");
    assert.equal(expandExtensionPrompt(prompts, "triage 磁盘满了"), "triage 磁盘满了");
    assert.equal(
      expandExtensionPrompt([{ name: "a", content: "x {{ args }} y" }], "/a hi"),
      "x hi y",
    );
  });
});

test("extension manager", async (t) => {
  const db = openDb(":memory:");
  const packageDir = writePackage(scratch("pkg"), DEMO_FILES);
  const brokenDir = writePackage(scratch("broken"), BROKEN_FILES);
  const home = scratch("home");
  const manager = new ExtensionManager(db, SECRET, home);
  t.after(() => db.close());

  await t.test("installing records the package and loads it", async () => {
    const { package: entry, loaded } = await manager.install(packageDir);
    assert.equal(entry.name, "demo-ext");
    assert.equal(entry.enabled, true);
    assert.equal(entry.id, extensionId(packageDir));
    const tool = loaded.tools.find((item) => item.toolName === "ext_echo");
    assert.ok(tool, JSON.stringify(loaded.tools.map((item) => item.name)));
    assert.equal(tool.name, `ext__${entry.id}__ext_echo`);
    assert.equal(tool.readOnly, true);
    // One skill comes from the manifest directory, one from code; the manifest
    // prompt file is picked up alongside them.
    assert.deepEqual(
      loaded.skills.map((skill) => skill.name),
      ["disk-check", "code-skill"],
    );
    assert.equal(loaded.skills[0].content.includes("du -sh"), true);
    assert.deepEqual(
      loaded.prompts.map((prompt) => prompt.name),
      ["triage", "code-prompt"],
    );
    assert.equal(loaded.prompts[0].content.includes("$ARGUMENTS"), true);
    assert.deepEqual(loaded.notes, ["扩展提示：改动前先确认备份。"]);
    assert.equal(loaded.guards.length, 1);
    assert.deepEqual(loaded.errors, []);
  });

  await t.test("the source is encrypted at rest", () => {
    const stored = db
      .prepare("SELECT value FROM settings WHERE key='extensions_enc'")
      .get();
    assert.ok(stored, "extensions_enc row missing");
    assert.equal(stored.value.includes("demo-ext"), false);
    assert.equal(stored.value.includes(packageDir), false);
  });

  await t.test("a package that fails to load does not hide the others", async () => {
    // Simulates a checkout that broke after it was installed, or an operator
    // hand-editing the stored list.
    writeExtensionPackages(db, SECRET, [
      ...manager.packages(false),
      { id: extensionId(brokenDir), name: "broken-ext", source: brokenDir, enabled: true, addedAt: 0 },
    ]);
    manager.invalidate();
    const loaded = await manager.load();
    assert.equal(
      loaded.tools.some((item) => item.toolName === "ext_echo"),
      true,
      "the healthy package must keep its tools",
    );
    assert.deepEqual(loaded.errors, [
      `broken-ext: broken_extension_on_purpose`,
    ]);
  });

  await t.test("tool calls return text and failures", async () => {
    const id = extensionId(packageDir);
    const echo = await manager.call(`ext__${id}__ext_echo`, { text: "hi" });
    assert.equal(echo.text, "echo:hi@demo-ext");
    assert.equal(echo.isError, false);
    assert.equal(echo.packageName, "demo-ext");
    const failed = await manager.call(`ext__${id}__ext_fail`, {});
    assert.equal(failed.isError, true);
    assert.equal(failed.text, "ext_fail_exploded");
    await assert.rejects(
      () => manager.call("ext__missing__nope", {}),
      /extension_tool_not_found/,
    );
  });

  await t.test("disabling and removing packages", async () => {
    const id = extensionId(packageDir);
    const brokenId = extensionId(brokenDir);
    manager.setEnabled(new Map([[id, false]]));
    const off = await manager.load();
    assert.equal(off.tools.some((item) => item.toolName === "ext_echo"), false);
    assert.equal(off.skills.length, 0);
    assert.equal(manager.packages(false).length, 2);
    assert.equal(manager.packages().length, 1);

    manager.setEnabled(new Map([[id, true]]));
    assert.equal((await manager.load()).skills.length, 2);
    assert.equal(manager.remove(brokenId).length, 1);
    assert.equal((await manager.load()).errors.length, 0);
    assert.throws(() => manager.remove(brokenId), /extension_not_found/);
  });

  await t.test("reinstalling the same source is refused", async () => {
    await assert.rejects(() => manager.install(packageDir), /duplicate_extension/);
  });

  await t.test("paths that are not packages are refused", async () => {
    await assert.rejects(
      () => manager.install(scratch("empty")),
      /extension_no_activate/,
    );
    // A directory with an entry that throws is reported with the real reason
    // and is not kept.
    await assert.rejects(
      () => manager.install(brokenDir),
      /extension_no_activate: broken_extension_on_purpose/,
    );
    assert.equal(
      manager.packages(false).some((entry) => entry.source === brokenDir),
      false,
    );
  });

  await t.test("removing a managed package deletes only its own checkout", () => {
    const source = "npm:demo-ext@1.2.3";
    const id = extensionId(source);
    const checkout = path.join(home, "npm", "demo-ext-1.2.3", "node_modules", "demo-ext");
    const other = path.join(home, "npm", "demo-ext-2.0.0", "node_modules", "demo-ext");
    writePackage(checkout, DEMO_FILES);
    writePackage(other, DEMO_FILES);
    writeExtensionPackages(db, SECRET, [
      ...manager.packages(false),
      { id, name: "demo-ext", source, enabled: true, addedAt: 0 },
    ]);
    manager.invalidate();
    assert.equal(manager.remove(id).some((entry) => entry.id === id), false);
    // The version is part of the directory name, so installing a second
    // version never reuses (or deletes) the first one's files.
    assert.equal(fs.existsSync(checkout), false);
    assert.equal(fs.existsSync(other), true);
  });
});

/** Chat helpers, mirroring ai-chat.test.mjs. */
async function chat(f, body) {
  const response = await fetch(`${f.url}/api/ai/machines/1/chat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${f.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    events: text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}

async function request(f, url, method = "GET", body) {
  const response = await fetch(f.url + url, {
    method,
    headers: {
      authorization: `Bearer ${f.token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

function toolsOf(turn) {
  const latest = new Map();
  for (const event of turn.events)
    if (event.type === "tool") latest.set(event.tool.id, event.tool);
  return [...latest.values()];
}

test("extensions over the API", async (t) => {
  // Extensions install into this directory instead of the data directory next
  // to the database, so the test never writes to the repository.
  process.env.EXTENSIONS_DIR = scratch("installed");
  const f = await harness();
  t.after(() => f.close());
  const packageDir = writePackage(scratch("pkg"), DEMO_FILES);

  const settings = {
    baseUrl: f.modelUrl,
    model: "fixture-model",
    protocol: "chat",
    apiKey: "fixture-key",
    allowPrivate: true,
  };
  assert.equal((await request(f, "/api/ai/settings", "PUT", settings)).status, 200);
  const inspected = await request(
    f,
    "/api/machines/1/workspace/host-key/inspect",
    "POST",
  );
  assert.equal(
    (await request(f, "/api/machines/1/workspace/host-key", "PUT", inspected.body)).status,
    200,
  );

  await t.test("the list starts empty and viewers may not change it", async () => {
    const empty = await request(f, "/api/ai/extensions");
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.packages, []);
    assert.deepEqual(empty.body.tools, []);
    assert.equal(empty.body.directory, process.env.EXTENSIONS_DIR);
    const refused = await fetch(`${f.url}/api/ai/extensions/install`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.viewerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ source: packageDir }),
    });
    assert.equal(refused.status, 403);
  });

  await t.test("bad sources are reported in Chinese-friendly codes", async () => {
    for (const [source, status, code] of [
      ["npm:--evil", 400, "extension_source_invalid"],
      ["/does/not/exist", 400, "extension_package_missing"],
    ]) {
      const result = await request(f, "/api/ai/extensions/install", "POST", { source });
      assert.equal(result.status, status, JSON.stringify(result.body));
      assert.equal(result.body.error, code);
    }
  });

  let toolName = "";
  await t.test("installing exposes the tools, skills and prompts", async () => {
    const installed = await request(f, "/api/ai/extensions/install", "POST", {
      source: packageDir,
    });
    assert.equal(installed.status, 200, JSON.stringify(installed.body));
    const [entry] = installed.body.packages;
    assert.equal(entry.name, "demo-ext");
    assert.equal(entry.enabled, true);
    assert.equal(entry.tools.length, 3);
    assert.deepEqual(entry.skills, ["disk-check", "code-skill"]);
    assert.deepEqual(entry.prompts, ["triage", "code-prompt"]);
    assert.deepEqual(installed.body.errors, []);
    toolName = installed.body.tools.find((tool) => tool.title === "回声").name;

    const duplicate = await request(f, "/api/ai/extensions/install", "POST", {
      source: packageDir,
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error, "duplicate_extension");
  });

  await t.test("the model can call an extension tool with its own arguments", async () => {
    const turn = await chat(f, {
      message: `调用扩展工具 [tool:${toolName} {"text":"hi"}]`,
      root: "/srv/app",
      autoRun: "read",
    });
    assert.equal(turn.status, 200, JSON.stringify(turn.events));
    const [tool] = toolsOf(turn);
    assert.equal(tool.name, toolName);
    assert.equal(tool.state, "ok");
    // The argument survived the tool call, which proves extension schemas are
    // not filtered through the built-in argument list.
    assert.equal(tool.output, "echo:hi@demo-ext");
    assert.equal(tool.readOnly, true);
    const answer = turn.events.find((event) => event.type === "answer");
    assert.ok(answer, "the turn still ends with an answer");
  });

  await t.test("a guard installed by the package blocks a tool", async () => {
    const blocked = toolName.replace("ext_echo", "ext_boom");
    const turn = await chat(f, {
      message: `调用扩展工具 [tool:${blocked}]`,
      root: "/srv/app",
      autoRun: "read",
    });
    const [tool] = toolsOf(turn);
    assert.equal(tool.state, "error");
    assert.equal(tool.output, "扩展策略：禁止磁盘清理");
    assert.equal(turn.events.some((event) => event.type === "error"), false);
  });

  await t.test("a skill can be read and a template can be expanded", async () => {
    const turn = await chat(f, {
      message: "[skill:disk-check]",
      root: "/srv/app",
      autoRun: "read",
    });
    const [tool] = toolsOf(turn);
    assert.equal(tool.name, "read_skill");
    // The package's guard throws for read_skill on purpose: a broken guard is
    // skipped instead of failing the turn.
    assert.equal(tool.state, "ok");
    assert.match(tool.output, /du -sh/);

    const before = f.modelRequests.length;
    const expanded = await chat(f, { message: "/triage 磁盘满了", root: "/srv/app", autoRun: "read" });
    assert.equal(expanded.status, 200);
    const sent = f.modelRequests
      .slice(before)
      .map((request_) => JSON.stringify(request_.messages))
      .join("\n");
    assert.match(sent, /请排查以下问题并给出结论：磁盘满了/);
    // The stored question stays the raw text the operator typed; the expansion
    // only happens on the way to the model.
    const stored = f.db
      .prepare("SELECT prompt FROM ai_runs ORDER BY rowid DESC LIMIT 1")
      .get();
    assert.equal(decryptText(stored.prompt, f.secret), "/triage 磁盘满了");
  });

  await t.test("disabling a package removes its tools", async () => {
    const list = await request(f, "/api/ai/extensions");
    const [entry] = list.body.packages;
    const off = await request(f, "/api/ai/extensions", "PUT", {
      packages: [{ id: entry.id, enabled: false }],
    });
    assert.equal(off.status, 200);
    assert.equal(off.body.packages[0].enabled, false);
    assert.deepEqual(off.body.tools, []);
    assert.deepEqual(off.body.skills, []);

    const on = await request(f, "/api/ai/extensions", "PUT", {
      packages: [{ id: entry.id, enabled: true }],
    });
    assert.equal(on.body.tools.length, 3);
    assert.equal((await request(f, "/api/ai/extensions/reload", "POST")).status, 200);
  });

  await t.test("removing a package forgets it", async () => {
    const list = await request(f, "/api/ai/extensions");
    const [entry] = list.body.packages;
    const removed = await request(f, "/api/ai/extensions/remove", "POST", {
      id: entry.id,
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.packages, []);
    // A local package belongs to the operator: removal must not delete it.
    assert.equal(fs.existsSync(path.join(packageDir, "package.json")), true);
    assert.equal(
      (await request(f, "/api/ai/extensions/remove", "POST", { id: entry.id })).status,
      404,
    );
  });
});
