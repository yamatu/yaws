import test from "node:test";
import assert from "node:assert/strict";
import { harness } from "./fixture.mjs";

/** Chat replies arrive as newline delimited JSON. */
async function chat(f, body, token = f.token) {
  const response = await fetch(`${f.url}/api/ai/machines/1/chat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    type: response.headers.get("content-type") ?? "",
    events: text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
    body: text,
  };
}

/** Every tool card appears twice (running, then the result); keep the last state. */
function toolsOf(turn) {
  const latest = new Map();
  for (const event of turn.events)
    if (event.type === "tool") latest.set(event.tool.id, event.tool);
  return [...latest.values()];
}

const settings = (f) => ({
  baseUrl: f.modelUrl,
  model: "fixture-model",
  protocol: "chat",
  apiKey: "fixture-key",
  allowPrivate: true,
});

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

const proposals = (f) =>
  f.db.prepare("SELECT id,status,kind FROM ai_proposals").all();

test("ai chat", async (t) => {
  const f = await harness();
  t.after(() => f.close());
  assert.equal(
    (await request(f, "/api/ai/settings", "PUT", settings(f))).status,
    200,
  );
  // The workspace refuses to touch a host with an unverified host key.
  const inspected = await request(f, "/api/machines/1/workspace/host-key/inspect", "POST");
  assert.equal(inspected.status, 200, JSON.stringify(inspected.body));
  assert.equal(
    (await request(f, "/api/machines/1/workspace/host-key", "PUT", inspected.body)).status,
    200,
  );

  await t.test("read-only commands run without approval", async () => {
    const before = f.commands.length;
    const turn = await chat(f, {
      root: "/srv/app",
      message: "[run] 看一下磁盘",
      autoRun: "read",
    });
    assert.equal(turn.status, 200, turn.body);
    assert.match(turn.type, /ndjson/);
    assert.equal(turn.events[0].type, "start");
    const tool = toolsOf(turn)[0];
    assert.equal(tool.name, "run_command");
    assert.equal(tool.state, "ok");
    assert.equal(tool.auto, true);
    assert.equal(tool.readOnly, true);
    assert.equal(turn.events.some((e) => e.type === "proposal"), false);
    assert.equal(
      f.commands.slice(before).some((command) => command.includes("df -h")),
      true,
    );
    const answer = turn.events.find((e) => e.type === "answer");
    assert.ok(answer.text.length > 0);
    assert.equal(turn.events.at(-1).type, "done");
    assert.equal(proposals(f).length, 0);
    const run = f.db
      .prepare("SELECT status,conversation_id,trace FROM ai_runs")
      .get();
    assert.equal(run.status, "completed");
    assert.ok(run.conversation_id);
    assert.ok(run.trace.length > 0);
  });

  await t.test("mutating commands wait for the operator", async () => {
    const before = f.commands.length;
    const turn = await chat(f, {
      root: "/srv/app",
      message: "[write] 重启 nginx",
      autoRun: "read",
    });
    const card = turn.events.find((e) => e.type === "proposal");
    assert.equal(card.proposal.kind, "command");
    assert.equal(card.proposal.status, "pending");
    assert.equal(card.proposal.after, "systemctl restart nginx");
    assert.equal(toolsOf(turn)[0].state, "awaiting");
    assert.equal(f.commands.length, before);
    assert.equal(
      (await request(f, `/api/ai/machines/1/proposals/${card.proposal.id}/apply`, "POST", {
        confirm: true,
      })).status,
      200,
    );
    assert.equal(
      f.commands.slice(before).some((c) => c.includes("systemctl restart nginx")),
      true,
    );
  });

  await t.test("dangerous commands are never auto-run", async () => {
    const before = f.commands.length;
    const turn = await chat(f, {
      root: "/srv/app",
      message: "[danger] 清理目录",
      autoRun: "all",
    });
    const card = turn.events.find((e) => e.type === "proposal");
    assert.equal(card.proposal.status, "pending");
    assert.equal(card.proposal.after, "rm -rf /srv/app");
    assert.equal(f.commands.length, before);
  });

  await t.test("file writes apply, keep a backup and revert", async () => {
    const original = f.files.get("/srv/app/config.json").toString();
    const turn = await chat(f, {
      root: "/srv/app",
      message: "[file] 更新配置",
      autoRun: "all",
    });
    const card = turn.events.find((e) => e.type === "proposal");
    assert.equal(card.proposal.kind, "file");
    assert.equal(card.proposal.status, "applied");
    assert.equal(card.proposal.before, original);
    assert.equal(f.files.get("/srv/app/config.json").toString(), '{"enabled":true}\n');
    assert.ok(
      [...f.files.keys()].some((key) => key.includes(".yaws-backup-")),
    );
    const reverted = await request(
      f,
      `/api/ai/machines/1/proposals/${card.proposal.id}/revert`,
      "POST",
      { confirm: true },
    );
    assert.equal(reverted.status, 200, JSON.stringify(reverted.body));
    assert.equal(f.files.get("/srv/app/config.json").toString(), original);
    assert.equal(
      (await request(f, `/api/ai/machines/1/proposals/${card.proposal.id}/revert`, "POST", {
        confirm: true,
      })).status,
      409,
    );
  });

  await t.test("file writes can also wait for approval", async () => {
    const original = f.files.get("/srv/app/config.json").toString();
    const turn = await chat(f, {
      root: "/srv/app",
      message: "[file] 更新配置",
      autoRun: "read",
    });
    const card = turn.events.find((e) => e.type === "proposal");
    assert.equal(card.proposal.status, "pending");
    assert.equal(f.files.get("/srv/app/config.json").toString(), original);
  });

  await t.test("logs and stats are readable", async () => {
    const log = await chat(f, {
      root: "/srv/app",
      message: "[log] 看下错误日志",
      autoRun: "read",
    });
    assert.equal(toolsOf(log)[0].readOnly, true);
    const stats = await chat(f, {
      root: "/srv/app",
      message: "[stats] 服务器状态",
      autoRun: "read",
    });
    const statsTool = toolsOf(stats)[0];
    assert.equal(statsTool.name, "server_stats");
    assert.equal(statsTool.state, "ok");
  });

  await t.test("secrets are refused before they reach the model", async () => {
    const turn = await chat(f, {
      root: "/srv/app",
      message: "[secret] 读取环境变量",
      autoRun: "all",
    });
    const tool = toolsOf(turn)[0];
    assert.equal(tool.state, "error");
    assert.equal(tool.output, "sensitive_file_blocked");
    assert.equal(
      f.modelRequests.some((requestBody) =>
        JSON.stringify(requestBody).includes("SECRET"),
      ),
      false,
    );
  });

  await t.test("several tool calls in one turn all report", async () => {
    const turn = await chat(f, {
      root: "/srv/app",
      message: "[many] 全面检查",
      autoRun: "read",
    });
    const names = toolsOf(turn).map((tool) => tool.name);
    assert.deepEqual(names, ["run_command", "server_stats", "list_files"]);
    assert.equal(turn.events.at(-1).type, "done");
  });

  await t.test("conversations keep their history", async () => {
    const first = await chat(f, {
      root: "/srv/app",
      message: "[run] 第一次提问",
      autoRun: "read",
    });
    const start = first.events.find((e) => e.type === "start");
    assert.ok(start.conversationId);
    const list = await request(f, "/api/ai/conversations?machineId=1");
    assert.equal(list.status, 200);
    const row = list.body.conversations.find(
      (c) => c.id === start.conversationId,
    );
    assert.ok(row);
    assert.ok(row.turns >= 1);
    const second = await chat(f, {
      root: "/srv/app",
      message: "[run] 第二次提问",
      autoRun: "read",
      conversationId: start.conversationId,
    });
    assert.equal(
      second.events.find((e) => e.type === "start").conversationId,
      start.conversationId,
    );
    const prompts = f.modelRequests
      .at(-1)
      .messages.map((m) => (typeof m.content === "string" ? m.content : ""));
    assert.equal(
      prompts.some((text) => text.includes("第一次提问")),
      true,
      "previous turn is replayed to the model",
    );
    const detail = await request(f, `/api/ai/conversations/${start.conversationId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.turns.length, 2);
    assert.equal(detail.body.turns[0].prompt, "[run] 第一次提问");
    assert.ok(detail.body.turns[0].answer.length > 0);
    assert.ok(detail.body.turns[0].trace.length > 0);
    assert.equal(
      (await request(f, `/api/ai/conversations/${start.conversationId}`, "DELETE"))
        .status,
      200,
    );
    assert.equal(
      (await request(f, `/api/ai/conversations/${start.conversationId}`)).status,
      404,
    );
  });

  await t.test("chat is admin-only and validates input", async () => {
    const viewer = await fetch(`${f.url}/api/ai/machines/1/chat`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.viewerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ root: "/srv/app", message: "hi" }),
    });
    assert.equal(viewer.status, 403);
    assert.equal(
      (
        await fetch(`${f.url}/api/ai/machines/1/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ root: "/srv/app", message: "hi" }),
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${f.url}/api/ai/machines/1/chat`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${f.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ root: "/srv/app" }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${f.url}/api/ai/machines/1/chat`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${f.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            root: "/srv/app",
            message: "hi",
            conversationId: "does-not-exist",
          }),
        })
      ).status,
      404,
    );
    const outside = await chat(f, {
      root: "/etc",
      message: "[list] 看看目录",
      autoRun: "read",
    });
    assert.equal(toolsOf(outside)[0].state, "error");
    assert.equal(toolsOf(outside)[0].output, "outside_workspace");
  });

  await t.test("legacy run endpoint still works", async () => {
    const run = await request(f, "/api/ai/machines/1/run", "POST", {
      root: "/srv/app",
      prompt: "Enable the config and propose validation.",
    });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(run.body.proposals.length, 2);
  });
});
