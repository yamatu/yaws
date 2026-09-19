import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { harness } from "./fixture.mjs";
import { renderInstallScript } from "../dist/install-script.js";
import {
  agentProviderOrder,
  agentSourcePlan,
  bundledAgentVersion,
  giteeReleaseBase,
  githubReleaseBase,
  httpBaseFromWs,
  isAgentAsset,
  isAgentChannel,
  readBundledAgent,
  repoRoot,
  sha256File,
} from "../dist/agent-release.js";
import { installCommand } from "../dist/agent-install.js";

const script = (overrides = {}) =>
  renderInstallScript({
    machineId: 3,
    wsUrl: "wss://panel.example.com/ws/agent",
    key: "agent-key",
    intervalSec: 5,
    order: agentProviderOrder("cn"),
    githubRepo: "yamatu/yaws",
    giteeRepo: "yamatu/yaws",
    releaseTag: "",
    githubBase: "https://github.com/yamatu/yaws/releases/latest/download",
    giteeBase: "",
    controllerBase: "https://panel.example.com",
    targetVersion: "v0.3.0",
    ...overrides,
  });

const env = (overrides = {}) => ({
  AGENT_GITHUB_REPO: "yamatu/yaws",
  AGENT_GITEE_REPO: "yamatu/yaws",
  ...overrides,
});

test("domestic and overseas channels only reorder the download sources", () => {
  assert.deepEqual(agentProviderOrder("cn"), ["gitee", "controller", "github"]);
  assert.deepEqual(agentProviderOrder("global"), ["github", "controller", "gitee"]);
  // Both orders keep the panel as a fallback, so a host with no route to either
  // forge can still install.
  for (const channel of ["cn", "global"])
    assert.ok(agentProviderOrder(channel).includes("controller"));
  assert.equal(isAgentChannel("cn"), true);
  assert.equal(isAgentChannel("CN"), false);
  assert.equal(isAgentChannel(undefined), false);
});

test("generated installer is valid bash and tries every source in order", () => {
  const text = script();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yaws-install-"));
  const file = path.join(dir, "install.sh");
  try {
    fs.writeFileSync(file, text);
    // Syntax errors are the one thing a test can catch without a target host.
    execFileSync("bash", ["-n", file], { stdio: "pipe" });
    assert.ok(text.startsWith("#!/usr/bin/env bash\n"));
    assert.ok(text.includes("ORDER='gitee controller github'"));
    assert.ok(text.includes("CONTROLLER_BASE='https://panel.example.com'"));
    assert.ok(text.includes("TARGET_VERSION='v0.3.0'"));
    assert.ok(text.includes("for provider in $ORDER; do"));
    assert.ok(text.includes("/api/agent/binary/$ASSET"));
    assert.ok(text.includes("ASSET=\"yaws-agent-linux-amd64\""));
    assert.ok(text.includes("ASSET=\"yaws-agent-linux-arm64\""));
    // A download only counts when the binary answers `-version`.
    assert.ok(text.includes('"$1" -version >/dev/null 2>&1'));
    // Both flags stay supported: the SSH installer passes --force, operators
    // use --check to see what a host is running.
    assert.ok(text.includes("--force) FORCE=1"));
    assert.ok(text.includes("--check) CHECK_ONLY=1"));
    // systemd when present, nohup otherwise.
    assert.ok(text.includes("systemctl daemon-reload"));
    assert.ok(text.includes("nohup \"$BIN\" -config \"$CFG\""));
    // The config is written as a quoted heredoc so the key never gets expanded.
    assert.ok(text.includes("cat > \"$CFG\" <<'JSON'"));
    assert.ok(text.includes('"key": "agent-key"'));
    assert.ok(text.includes('"url": "wss://panel.example.com/ws/agent"'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("release bases follow the pinned tag and the provider quirks", () => {
  const both = env({ AGENT_RELEASE_TAG: "v0.3.0" });
  assert.equal(
    githubReleaseBase(both),
    "https://github.com/yamatu/yaws/releases/download/v0.3.0",
  );
  assert.equal(
    giteeReleaseBase(both),
    "https://gitee.com/yamatu/yaws/releases/download/v0.3.0",
  );
  // GitHub has a "latest" alias, Gitee does not: without a tag the installer has
  // to ask the Gitee API for the newest tag instead of guessing a URL.
  assert.equal(
    githubReleaseBase(env()),
    "https://github.com/yamatu/yaws/releases/latest/download",
  );
  assert.equal(giteeReleaseBase(env()), "");
  assert.equal(giteeReleaseBase(env({ AGENT_GITEE_REPO: "" })), "");
  assert.equal(
    githubReleaseBase(env({ AGENT_RELEASE_BASE_URL: "https://mirror.example.com/a/" })),
    "https://mirror.example.com/a",
  );
  assert.equal(
    giteeReleaseBase(env({ AGENT_GITEE_RELEASE_BASE_URL: "https://gitee.example.com/a/" })),
    "https://gitee.example.com/a",
  );
  assert.equal(giteeReleaseBase(env({ AGENT_GITEE_REPO: "  " })), "");
});

test("the controller origin is derived from the agent websocket url", () => {
  assert.equal(
    httpBaseFromWs("wss://panel.example.com/ws/agent"),
    "https://panel.example.com",
  );
  assert.equal(httpBaseFromWs("ws://10.0.0.5:3001/ws/agent"), "http://10.0.0.5:3001");
  // A panel behind a path prefix keeps it.
  assert.equal(httpBaseFromWs("wss://host/yaws/ws/agent"), "https://host/yaws");
  assert.equal(httpBaseFromWs("wss://host/yaws/"), "https://host/yaws");
  assert.equal(httpBaseFromWs(""), "");
  // An http(s) address is not something the agent dials.
  assert.equal(httpBaseFromWs("https://host/ws/agent"), "");
  assert.equal(httpBaseFromWs("not a url"), "");
});

test("source plan lists the reachable sources in the channel order", () => {
  const plan = agentSourcePlan({
    env: env(),
    channel: "cn",
    controllerBase: "https://panel.example.com",
    targetVersion: "v0.3.0",
  });
  assert.deepEqual(plan.order, ["gitee", "controller", "github"]);
  assert.deepEqual(
    plan.sources.map((s) => s.provider),
    ["gitee", "controller", "github"],
  );
  assert.equal(plan.targetVersion, "v0.3.0");
  assert.equal(plan.sources[1].detail, "https://panel.example.com/api/agent/binary/<架构>");
  // Without a pinned tag the Gitee entry documents the API lookup it will do.
  assert.match(plan.sources[0].detail, /gitee\.com\/api\/v5\/repos\/yamatu\/yaws/);
  // A channel that cannot reach anything but the panel still installs.
  const bare = agentSourcePlan({
    env: env({ AGENT_GITHUB_REPO: "", AGENT_GITEE_REPO: "" }),
    channel: "cn",
    controllerBase: "https://panel.example.com",
    targetVersion: "",
  });
  assert.deepEqual(
    bare.sources.map((s) => s.provider),
    ["controller"],
  );
  // The installer is given the same filtered list, so it never announces a
  // source that has no repository configured.
  assert.deepEqual(bare.order, ["controller"]);
  // Without a controller address there is nothing to fall back to.
  assert.deepEqual(
    agentSourcePlan({
      env: env({ AGENT_GITHUB_REPO: "", AGENT_GITEE_REPO: "" }),
      channel: "global",
      controllerBase: "",
      targetVersion: "",
    }).order,
    [],
  );
});

test("bundled builds are read, hashed and versioned", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yaws-bin-"));
  try {
    const bytes = Buffer.from("pretend agent\n");
    fs.writeFileSync(path.join(dir, "yaws-agent-linux-amd64"), bytes);
    const found = readBundledAgent(env({ AGENT_BINARY_DIR: dir }), "yaws-agent-linux-amd64");
    assert.ok(found);
    assert.equal(found.bytes, bytes.length);
    assert.equal(found.sha256, createHash("sha256").update(bytes).digest("hex"));
    // A text file is not a runnable agent on any platform, so the version is
    // unknown instead of an exception.
    assert.equal(found.version, "");
    const version = bundledAgentVersion(env({ AGENT_BINARY_DIR: dir }));
    assert.equal(version.asset, "yaws-agent-linux-amd64");
    assert.equal(version.bytes, bytes.length);
    // A missing directory is "no build here", not an error.
    assert.equal(readBundledAgent(env({ AGENT_BINARY_DIR: path.join(dir, "nope") }), "yaws-agent-linux-arm64"), null);
    assert.deepEqual(bundledAgentVersion(env({ AGENT_BINARY_DIR: path.join(dir, "nope") })), {
      version: "",
      asset: null,
      bytes: 0,
    });
    // An empty file is treated as a broken download.
    fs.writeFileSync(path.join(dir, "yaws-agent-linux-arm64"), "");
    assert.equal(readBundledAgent(env({ AGENT_BINARY_DIR: dir }), "yaws-agent-linux-arm64"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the builds committed to the repository match their published checksums", () => {
  const dir = path.join(repoRoot(), "agent", "bin");
  const sums = fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8");
  const expected = new Map(
    sums
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, name] = line.trim().split(/\s+/);
        return [name.replace(/^\*/, ""), hash];
      }),
  );
  for (const asset of ["yaws-agent-linux-amd64", "yaws-agent-linux-arm64"]) {
    assert.ok(isAgentAsset(asset));
    assert.ok(expected.has(asset), `${asset} is missing from SHA256SUMS`);
    assert.equal(
      sha256File(path.join(dir, asset)),
      expected.get(asset),
      `${asset} does not match SHA256SUMS`,
    );
  }
  // agent/bin is tracked on purpose: the panel serves these bytes.
  assert.equal(fs.statSync(path.join(dir, "yaws-agent-linux-amd64")).isFile(), true);
});

test("the ssh installer wraps the script so sudo can re-exec it", () => {
  const plain = installCommand([]);
  assert.ok(plain.startsWith("sh -c 'd=\"$(mktemp -d)\""));
  assert.ok(plain.includes("cat > \"$d/install.sh\""));
  assert.ok(plain.includes("bash \"$d/install.sh\""));
  assert.ok(plain.includes("rm -rf \"$d\""));
  assert.ok(!plain.includes("--force"));
  assert.ok(installCommand(["--force"]).includes("bash \"$d/install.sh\" '--force'"));
});

test("one-click install over ssh streams the log and reports the version", async (t) => {
  const f = await harness();
  t.after(() => f.close());
  const trust = async (id) => {
    const inspected = await request(f, `/api/machines/${id}/workspace/host-key/inspect`, "POST");
    assert.equal(inspected.status, 200, JSON.stringify(inspected.body));
    const saved = await request(f, `/api/machines/${id}/workspace/host-key`, "PUT", inspected.body);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  };

  await t.test("the options endpoint reports the plan and the ssh state", async () => {
    const before = await request(f, "/api/machines/1/agent/install");
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.equal(before.body.plan.order[0], "gitee");
    assert.deepEqual(
      before.body.channels.map((c) => c.id),
      ["cn", "global"],
    );
    assert.equal(before.body.credentialState, "ok");
    // The host key has not been confirmed yet, so the button must stay disabled.
    assert.equal(before.body.hostTrusted, false);
    await trust(1);
    const after = await request(f, "/api/machines/1/agent/install");
    assert.equal(after.body.hostTrusted, true);
    assert.equal(after.body.plan.targetVersion, "");
    assert.equal(after.body.bundledBytes, f.agentBytes["yaws-agent-linux-amd64"].length);
    const global = await request(f, "/api/machines/1/agent/install?channel=global");
    assert.equal(global.body.plan.order[0], "github");
    // Unknown channel falls back to the domestic order.
    const bogus = await request(f, "/api/machines/1/agent/install?channel=whatever");
    assert.equal(bogus.body.plan.order[0], "gitee");
    assert.equal((await request(f, "/api/machines/99/agent/install")).status, 404);
  });

  await t.test("the panel hands out its own agent build", async () => {
    const bytes = f.agentBytes["yaws-agent-linux-amd64"];
    const sha = createHash("sha256").update(bytes).digest("hex");
    const response = await fetch(`${f.url}/api/agent/binary/yaws-agent-linux-amd64`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-agent-sha256"), sha);
    assert.match(response.headers.get("content-disposition") ?? "", /yaws-agent-linux-amd64/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    // The installer fetches the companion checksum next to the binary.
    const sum = await fetch(`${f.url}/api/agent/binary/yaws-agent-linux-amd64.sha256`);
    assert.equal(sum.status, 200);
    assert.equal((await sum.text()).trim(), `${sha}  yaws-agent-linux-amd64`);
    // Anything outside the allow-list stays invisible: no traversal, no other
    // architecture. Unknown paths fall through to the dashboard's HTML 404.
    for (const bad of [
      "etc/passwd",
      "yaws-agent-darwin-arm64",
      "..%2Fpackage.json",
      "yaws-agent-linux-amd64%2F..%2F..%2Fpackage.json",
    ]) {
      const res = await fetch(`${f.url}/api/agent/binary/${bad}`);
      assert.notEqual(res.headers.get("content-type"), "application/octet-stream");
      assert.equal(res.headers.get("x-agent-sha256"), null);
      const body = await res.text();
      assert.ok(!body.includes("\"name\": \"yaws\""), `${bad} served a repository file`);
    }
  });

  await t.test("installing over ssh pipes the script and finishes with a version", async () => {
    const run = await install(f, { channel: "cn" });
    assert.equal(run.status, 200);
    assert.equal(run.events[0].type, "start");
    assert.equal(run.events[0].channel, "cn");
    assert.equal(run.events.at(-1).type, "done");
    assert.equal(run.events.at(-1).provider, "controller");
    // The fixture answers `yaws-agent -version` with v0.3.0.
    assert.equal(run.events.at(-1).version, "v0.3.0");
    const logs = run.events.filter((e) => e.type === "log");
    assert.ok(logs.some((e) => e.text.includes("已通过 controller 安装")));
    // The remote side really received the installer, not just a command line.
    assert.equal(f.installs.length, 1);
    const received = f.installs[0];
    assert.ok(received.command.includes("install.sh"));
    assert.ok(received.script.includes("ORDER='gitee controller github'"));
    assert.ok(received.script.includes('"id": 1'));
    assert.ok(received.script.includes('"key"'));
    assert.ok(received.script.includes("CONTROLLER_BASE='http://127.0.0.1:"));
    // No --force: clicking twice must not re-download a current agent.
    assert.ok(!received.command.includes("--force"));
  });

  await t.test("a second channel only changes the order", async () => {
    await install(f, { channel: "global", force: true });
    const received = f.installs.at(-1);
    assert.ok(received.script.includes("ORDER='github controller gitee'"));
    assert.ok(received.command.includes("'--force'"));
  });

  await t.test("a failing installer surfaces stderr and the exit code", async () => {
    f.setInstallReply(() => ({ code: 7, out: ["[1/4] 获取探针"], err: ["curl: (7) connect failed"] }));
    const run = await install(f, { channel: "cn" });
    assert.equal(run.status, 200);
    assert.deepEqual(run.events.at(-1), { type: "error", error: "agent_install_failed:7" });
    const logs = run.events.filter((e) => e.type === "log");
    assert.ok(logs.some((e) => e.stream === "err" && e.text.includes("curl: (7)")));
  });

  await t.test("a run in flight refuses a second one, and aborts release the slot", async () => {
    f.setInstallReply(() => ({ hang: true, out: ["[1/4] 获取探针"] }));
    const ac = new AbortController();
    const first = install(f, { channel: "cn", signal: ac.signal }).catch(() => null);
    await until(() => f.installs.length >= 1);
    const busy = await request(f, "/api/machines/1/agent/install", "POST", { channel: "cn" });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.error, "agent_install_running");
    // Aborting the request has to free the machine again, otherwise the button
    // would stay dead until the panel restarts.
    ac.abort();
    await first;
    f.setInstallReply(null);
    // The server notices the dropped connection asynchronously, so give the
    // release a moment before insisting the machine is usable again.
    const again = await untilValue(async () => {
      const run = await install(f, { channel: "cn" });
      return run.status === 409 ? null : run;
    });
    assert.equal(again.status, 200);
    assert.equal(again.events.at(-1).type, "done");
  });

  await t.test("an untrusted host key is refused before the stream opens", async () => {
    await trust(2);
    // An operator who edits the host or port has to confirm the new key first.
    f.db
      .prepare("UPDATE machines SET ssh_host_fingerprint = '', ssh_fingerprint_address = '' WHERE id = 2")
      .run();
    const refused = await request(f, "/api/machines/2/agent/install", "POST", { channel: "cn" });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, "ssh_host_untrusted");
    const info = await request(f, "/api/machines/2/agent/install");
    assert.equal(info.body.hostTrusted, false);
    assert.equal(info.body.credentialState, "ok");
  });

  await t.test("the manual script is served for both channels", async () => {
    const cn = await fetch(`${f.url}/api/machines/1/install-script`, {
      headers: { authorization: `Bearer ${f.token}` },
    });
    assert.equal(cn.status, 200);
    assert.match(cn.headers.get("content-type") ?? "", /text\/plain/);
    assert.ok((await cn.text()).includes("ORDER='gitee controller github'"));
    const global = await fetch(`${f.url}/api/machines/1/install-script?channel=global`, {
      headers: { authorization: `Bearer ${f.token}` },
    });
    assert.ok((await global.text()).includes("ORDER='github controller gitee'"));
    // The agent address is taken from the machine row when it has one.
    f.db
      .prepare("UPDATE machines SET agent_ws_url = ? WHERE id = 1")
      .run("wss://agent.example.com/ws/agent");
    const custom = await fetch(`${f.url}/api/machines/1/install-script`, {
      headers: { authorization: `Bearer ${f.token}` },
    });
    const text = await custom.text();
    assert.ok(text.includes('"url": "wss://agent.example.com/ws/agent"'));
    assert.ok(text.includes("CONTROLLER_BASE='https://agent.example.com'"));
  });

  await t.test("a machine without an agent key cannot be installed", async () => {
    f.db.prepare("UPDATE machines SET agent_key_enc = '' WHERE id = 3").run();
    const info = await request(f, "/api/machines/3/agent/install");
    assert.equal(info.status, 409);
    assert.equal(info.body.error, "no_key");
    assert.equal((await request(f, "/api/machines/3/agent/install", "POST", {})).body.error, "no_key");
    assert.equal((await request(f, "/api/machines/abc/agent/install", "POST", {})).status, 400);
  });

  await t.test("only administrators can install or download", async () => {
    assert.equal((await fetch(`${f.url}/api/machines/1/agent/install`)).status, 401);
    assert.equal(
      (
        await fetch(`${f.url}/api/machines/1/agent/install`, {
          headers: { authorization: `Bearer ${f.viewerToken}` },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${f.url}/api/machines/1/install-script`, {
          headers: { authorization: `Bearer ${f.viewerToken}` },
        })
      ).status,
      403,
    );
    // The agent itself has no credential yet, so its download stays public.
    assert.equal((await fetch(`${f.url}/api/agent/binary/yaws-agent-linux-amd64`)).status, 200);
  });
});

/** POST an install and collect every NDJSON event. */
async function install(f, { channel, force = false, signal } = {}) {
  const response = await fetch(`${f.url}/api/machines/1/agent/install`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${f.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ channel, force }),
    signal,
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
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

/** Poll until the predicate holds; fails the test instead of hanging forever. */
async function until(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Poll until the attempt produces a value, then return it. */
async function untilValue(attempt, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await attempt();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for a value");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
